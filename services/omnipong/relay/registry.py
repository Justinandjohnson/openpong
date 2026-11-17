"""In-memory session/companion registry — the relay's only state store.

Deliberately in-memory (per RELAY_ARCHITECTURE.md §2.1: "in-memory (or small
KV)"). The relay holds no credentials and no page content, so losing this
state on restart is an acceptable, documented trade-off (companions
reconnect and re-register; in-flight sessions are lost, which is the same
failure shape as F1/F3 in §7). Swapping in a KV store later is a storage-
layer change, not a protocol change — nothing above this module needs to
know.

The one piece of state that DOES persist is the pairing store (§2.3): a
pairing token is a long-lived companion credential minted for exactly one
owner, so it is written to a small JSON file and reloaded at startup.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

# Framework-agnostic: registry.py has no FastAPI/Starlette import. The
# companion's live websocket handle is stashed as Any so server.py can force-
# close it from the heartbeat watcher without this module depending on ASGI.
from errors import (
    CompanionNotOnline,
    PairingNotFound,
    PairingStoreUnavailable,
    SessionConflict,
    UnknownGate,
    UnknownSession,
)

# A companion's outbound send is duck-typed: anything with an async
# `send_json_to_companion(dict) -> None`. server.py supplies the real
# Starlette WebSocket-backed implementation; tests supply a fake.
SendFn = Callable[[dict], Awaitable[None]]


@dataclass
class Companion:
    register_token: str
    user_id: str  # the owner id this companion is paired to (§2.3)
    send: SendFn
    connected_at: float = field(default_factory=time.time)
    last_heartbeat: float = field(default_factory=time.time)
    online: bool = True
    websocket: Any = None  # set by server.py; used only to force-close on a missed heartbeat

    # Per-channel demux for the CDP devtools websockets multiplexed over
    # this companion's single tunnel (§1.3/§4.3). One companion has at most
    # one active session, so channel numbering resets per session.
    next_channel: int = 1
    agent_ws_send: dict[int, SendFn] = field(default_factory=dict)

    # Pending RPCs waiting on a companion reply, keyed by req_id / channel.
    pending_http: dict[str, "asyncio.Future[dict]"] = field(default_factory=dict)
    pending_ws_open: dict[int, "asyncio.Future[None]"] = field(default_factory=dict)

    @property
    def owner_id(self) -> str:
        """Alias for `user_id` — the owner this companion is paired to."""
        return self.user_id

    def allocate_channel(self) -> int:
        ch = self.next_channel
        self.next_channel += 1
        return ch


@dataclass
class Gate:
    gate_id: str
    session_id: str
    kind: str
    hint: str
    url_host: str
    created_at: float = field(default_factory=time.time)
    cleared: asyncio.Event = field(default_factory=asyncio.Event)
    timed_out: bool = False
    timeout_task: Optional[asyncio.Task] = None


@dataclass
class Session:
    session_id: str
    session_token: str
    user_id: str
    companion: Companion
    created_at: float = field(default_factory=time.time)
    last_cdp_activity: float = field(default_factory=time.time)
    ended: bool = False
    end_reason: Optional[str] = None
    gates: dict[str, Gate] = field(default_factory=dict)
    # gate_ids currently OPEN (not yet cleared or timed out). Non-empty means
    # the idle watcher must not reap this session — GATE_TTL governs instead
    # (C1: no CDP frames flow while a gate is open, by design).
    open_gate_ids: set[str] = field(default_factory=set)
    # Push-back events for the agent's SSE stream (§8.3 / GET /session/events).
    events: "asyncio.Queue[dict]" = field(default_factory=asyncio.Queue)
    idle_task: Optional[asyncio.Task] = None
    max_task: Optional[asyncio.Task] = None

    def touch(self) -> None:
        self.last_cdp_activity = time.time()


class PairingStore:
    """Pairing tokens: token -> owner_id, one owner per token and one live
    pairing per owner. Mintable and revocable through the operator-gated
    /pairing endpoints; persisted to a small JSON file so a companion's
    credential survives a relay restart.

    This is the per-user identity primitive (§2.3): a companion presents its
    pairing token, the relay resolves it to exactly one owner, and
    /session/start refuses any session whose claimed owner differs.
    """

    def __init__(self, path: Optional[str] = None):
        self._path = Path(path) if path else None
        self._tokens_by_owner: dict[str, str] = {}
        self._owner_by_token: dict[str, str] = {}

    # -- loading ---------------------------------------------------------

    def load(self, static: dict[str, str] | None = None) -> None:
        """Merge static provisioning then the persisted dynamic file.

        The persisted file wins on a token collision (a re-mint for the same
        owner rotates the token, and the file is the source of truth).
        """
        for token, owner in (static or {}).items():
            self._index(token, owner)
        if self._path and self._path.exists():
            with self._path.open("r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                raise ValueError(f"{self._path} must contain a JSON object of {{token: owner_id}}")
            for token, owner in data.items():
                self._index(str(token), str(owner))

    def _index(self, token: str, owner: str) -> None:
        # A token maps to exactly one owner; if it was previously indexed to a
        # different owner, drop the stale reverse entry first.
        previous_owner = self._owner_by_token.get(token)
        if previous_owner is not None and previous_owner != owner:
            self._tokens_by_owner.pop(previous_owner, None)
        previous_token = self._tokens_by_owner.get(owner)
        if previous_token is not None and previous_token != token:
            self._owner_by_token.pop(previous_token, None)
        self._owner_by_token[token] = owner
        self._tokens_by_owner[owner] = token

    # -- lookups ---------------------------------------------------------

    def resolve(self, token: str) -> Optional[str]:
        return self._owner_by_token.get(token)

    def token_for_owner(self, owner: str) -> Optional[str]:
        return self._tokens_by_owner.get(owner)

    def owners(self) -> list[str]:
        return list(self._tokens_by_owner.keys())

    def fingerprint(self, owner: str) -> Optional[str]:
        """A short, non-reversible hint for the UI (never the token itself)."""
        token = self._tokens_by_owner.get(owner)
        if token is None:
            return None
        import hashlib

        return hashlib.sha256(token.encode("utf-8")).hexdigest()[:12]

    # -- mint / revoke ---------------------------------------------------

    def mint(self, owner: str) -> str:
        """Create (or rotate) the pairing token for an owner and persist it."""
        token = f"rt_{secrets.token_urlsafe(32)}"
        self._index(token, owner)
        self._persist()
        return token

    def revoke(self, owner: str) -> bool:
        """Revoke an owner's pairing. Returns True if a pairing existed."""
        token = self._tokens_by_owner.pop(owner, None)
        if token is None:
            return False
        self._owner_by_token.pop(token, None)
        self._persist()
        return True

    def _persist(self) -> None:
        if self._path is None:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            # Atomic write: a crash mid-write must not corrupt every pairing.
            fd, tmp = tempfile.mkstemp(dir=str(self._path.parent), prefix=".pairings-")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(self._owner_by_token, f, indent=2, sort_keys=True)
                    f.write("\n")
                os.replace(tmp, self._path)
            except BaseException:
                if os.path.exists(tmp):
                    os.unlink(tmp)
                raise
        except OSError as exc:
            raise PairingStoreUnavailable(
                f"could not persist pairings to {self._path}: {exc}"
            ) from exc


class Registry:
    """All relay state. One instance per process; no external dependency."""

    def __init__(self, pairings_path: Optional[str] = None) -> None:
        self.register_tokens: dict[str, str] = {}
        self.pairings = PairingStore(pairings_path)
        self.companions_by_user_id: dict[str, Companion] = {}
        self.sessions_by_token: dict[str, Session] = {}
        self.sessions_by_user_id: dict[str, Session] = {}

    def load_register_tokens(self, tokens: dict[str, str]) -> None:
        self.register_tokens = dict(tokens)

    def load_pairings(self, static_tokens: dict[str, str]) -> None:
        self.load_register_tokens(static_tokens)
        self.pairings.load(static_tokens)

    # -- Pairing / identity ------------------------------------------------

    def resolve_pairing_token(self, token: str) -> Optional[str]:
        return self.pairings.resolve(token)

    def pairing_token_for_owner(self, owner: str) -> Optional[str]:
        return self.pairings.token_for_owner(owner)

    def mint_pairing(self, owner: str) -> str:
        return self.pairings.mint(owner)

    def revoke_pairing(self, owner: str) -> bool:
        return self.pairings.revoke(owner)

    def resolve_owner(self, *, owner: Optional[str], pairing_token: Optional[str]) -> str:
        """Resolve the effective owner for /session/start (§2.3).

        - With a pairing token: its owner is authoritative. A conflicting
          `owner` claim is an OwnerMismatch, refused in the relay.
        - With only an owner: the owner must have a live pairing (i.e. a
          companion actually registered with that owner's pairing token),
          otherwise there is nothing to bind a session to.
        """
        from errors import OwnerMismatch

        if pairing_token:
            paired_owner = self.pairings.resolve(pairing_token)
            if paired_owner is None:
                return ""  # caller maps "" to BadPairingToken
            if owner is not None and owner != paired_owner:
                raise OwnerMismatch(
                    f"pairing token belongs to owner {paired_owner!r}, not {owner!r}"
                )
            return paired_owner
        if not owner:
            return ""
        if self.pairings.token_for_owner(owner) is None:
            raise PairingNotFound(f"owner {owner!r} has no pairing token")
        return owner

    # -- Companion lifecycle -------------------------------------------------

    def resolve_register_token(self, register_token: str) -> Optional[str]:
        return self.pairings.resolve(register_token)

    def register_companion(self, register_token: str, user_id: str, send: SendFn) -> Companion:
        companion = Companion(register_token=register_token, user_id=user_id, send=send)
        self.companions_by_user_id[user_id] = companion
        return companion

    def unregister_companion(self, companion: Companion) -> Optional[Session]:
        """Mark a companion offline and return its bound session, if any."""
        companion.online = False
        if self.companions_by_user_id.get(companion.user_id) is companion:
            del self.companions_by_user_id[companion.user_id]
        return self.sessions_by_user_id.get(companion.user_id)

    def get_online_companion(self, user_id: str) -> Companion:
        companion = self.companions_by_user_id.get(user_id)
        if companion is None or not companion.online:
            raise CompanionNotOnline(f"no online companion for owner={user_id!r}")
        return companion

    def is_owner_connected(self, owner: str) -> bool:
        companion = self.companions_by_user_id.get(owner)
        return companion is not None and companion.online

    def gates_for_owner(self, owner: str) -> list[Gate]:
        session = self.sessions_by_user_id.get(owner)
        if session is None or session.ended:
            return []
        return [session.gates[gid] for gid in session.open_gate_ids if gid in session.gates]

    # -- Session lifecycle -----------------------------------------------------

    def start_session(self, user_id: str, companion: Companion, takeover: bool) -> Session:
        existing = self.sessions_by_user_id.get(user_id)
        if existing is not None and not existing.ended:
            if not takeover:
                raise SessionConflict(
                    f"owner={user_id!r} already has an active session "
                    f"(session_id={existing.session_id!r}); pass takeover=true to replace it"
                )
            existing.ended = True
            existing.end_reason = "takeover"

        session = Session(
            session_id=f"s_{uuid.uuid4().hex[:12]}",
            session_token=f"st_{secrets.token_urlsafe(32)}",
            user_id=user_id,
            companion=companion,
        )
        self.sessions_by_token[session.session_token] = session
        self.sessions_by_user_id[user_id] = session
        companion.next_channel = 1
        companion.agent_ws_send.clear()
        return session

    def get_session(self, session_token: str) -> Session:
        session = self.sessions_by_token.get(session_token)
        if session is None or session.ended:
            raise UnknownSession("no active session for session_token")
        return session

    def end_session(self, session: Session, reason: str) -> None:
        if session.ended:
            return
        session.ended = True
        session.end_reason = reason
        for task in (session.idle_task, session.max_task):
            if task is not None:
                task.cancel()
        for gate in session.gates.values():
            if gate.timeout_task is not None:
                gate.timeout_task.cancel()
        if self.sessions_by_token.get(session.session_token) is session:
            del self.sessions_by_token[session.session_token]
        if self.sessions_by_user_id.get(session.user_id) is session:
            del self.sessions_by_user_id[session.user_id]

    # -- Gate lifecycle ----------------------------------------------------

    def open_gate(self, session: Session, gate_id: str, kind: str, hint: str, url_host: str) -> Gate:
        gate = Gate(gate_id=gate_id, session_id=session.session_id, kind=kind, hint=hint, url_host=url_host)
        session.gates[gate_id] = gate
        session.open_gate_ids.add(gate_id)
        session.touch()
        return gate

    def get_gate(self, session: Session, gate_id: str) -> Gate:
        gate = session.gates.get(gate_id)
        if gate is None:
            raise UnknownGate(f"no gate {gate_id!r} on session {session.session_id!r}")
        return gate

    def clear_gate(self, session: Session, gate_id: str) -> Gate:
        gate = self.get_gate(session, gate_id)
        gate.cleared.set()
        if gate.timeout_task is not None:
            gate.timeout_task.cancel()
        session.open_gate_ids.discard(gate_id)
        session.touch()
        return gate
