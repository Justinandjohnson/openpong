"""OpenPong relay server — ported from the upstream OmniPong relay (Agent A).

Implements docs/RELAY_ARCHITECTURE.md:
  §1  CDP HTTP-facade + devtools websocket multiplexing over one companion tunnel
  §2  companion/session auth & lifecycle (per-user pairing, §2.3)
  §3  wait_for_human gate routing (relay only relays; content-blind)
  §4  message schemas (see protocol.py for the wire type constants)
  §5  security: relay never parses CDP_WS_FRAME.data, never sees credentials
  §7  failure modes: every error is one clean typed exception, no retries

Single framework choice: FastAPI + Starlette's built-in WebSocket support
(via uvicorn[standard], which bundles the `websockets` library as its ASGI
WS implementation) — no second WS library, no dependency that isn't used.

Per-user identity (§2.3, the OpenPong change): a companion is paired to
exactly ONE owner through a revocable pairing token, and /session/start
refuses any session whose claimed owner does not match that pairing. The
enforcement lives here in the relay, never only in a client.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import config
import protocol as P
from errors import (
    BadOperatorToken,
    BadPairingToken,
    CompanionUnresponsive,
    OperatorTokenNotConfigured,
    OwnerMismatch,
    RelayError,
)
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from registry import Companion, PairingStore, Registry, Session

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s relay: %(message)s")
log = logging.getLogger("relay")

registry = Registry()


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # The persisted pairing store is (re)bound at startup so a test or a
    # redeploy can point RELAY_PAIRINGS_FILE somewhere else without touching
    # the module import order.
    registry.pairings = PairingStore(config.PAIRINGS_FILE)
    static_tokens = config.load_register_tokens()
    registry.load_pairings(static_tokens)
    log.info(
        "loaded %d static token(s) from %s; %d pairing(s) persisted in %s",
        len(static_tokens),
        config.REGISTER_TOKENS_FILE,
        len(registry.pairings.owners()),
        config.PAIRINGS_FILE,
    )
    yield


app = FastAPI(title="OpenPong Relay", version="0.2.0", lifespan=_lifespan)


def _error_response(exc: RelayError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content=exc.to_dict())


@app.exception_handler(RelayError)
async def _relay_error_handler(_request: Request, exc: RelayError) -> JSONResponse:
    return _error_response(exc)


# ---------------------------------------------------------------------------
# §2.3 — per-user pairing (operator-gated)
# ---------------------------------------------------------------------------


@app.post("/pairing")
async def mint_pairing(request: Request) -> JSONResponse:
    """Mint (or rotate) the pairing token for one owner.

    Owner-scoped by construction: the caller names an owner and gets a token
    bound to exactly that owner. Revocable via DELETE /pairing/{owner}. The
    token is returned exactly once here (it is the companion's credential);
    only a short fingerprint is ever exposed afterwards.
    """
    _require_operator_token(request)
    body = await request.json()
    owner = (body.get("owner") or "").strip()
    if not owner:
        raise HTTPException(400, "owner required")
    token = registry.mint_pairing(owner)
    return JSONResponse(
        {"owner": owner, "pairing_token": token, "fingerprint": registry.pairings.fingerprint(owner)},
        status_code=201,
    )


@app.delete("/pairing/{owner}")
async def revoke_pairing(owner: str, request: Request) -> JSONResponse:
    _require_operator_token(request)
    revoked = registry.revoke_pairing(owner)
    return JSONResponse({"owner": owner, "revoked": revoked})


@app.get("/companions/{owner}")
async def companion_status(owner: str, request: Request) -> JSONResponse:
    """Owner-scoped status for the dashboard's "Your computer" card.

    Reports whether the owner has a pairing, whether a companion is connected
    right now, and any open human gate for the owner's live session.
    """
    _require_operator_token(request)
    gates = [
        {
            "gate_id": gate.gate_id,
            "kind": gate.kind,
            "hint": gate.hint,
            "url_host": gate.url_host,
            "created_at": gate.created_at,
        }
        for gate in registry.gates_for_owner(owner)
    ]
    return JSONResponse(
        {
            "owner": owner,
            "paired": registry.pairing_token_for_owner(owner) is not None,
            "fingerprint": registry.pairings.fingerprint(owner),
            "connected": registry.is_owner_connected(owner),
            "gates": gates,
        }
    )


@app.post("/companions/{owner}/gates/{gate_id}/clear")
async def clear_gate_for_owner(owner: str, gate_id: str, request: Request) -> JSONResponse:
    """The dashboard's "I handled it, continue" action.

    Same underlying gate primitive as the companion's own Continue button:
    clear the gate, wake the agent's SSE stream, and tell the companion so its
    local prompt closes. Owner-scoped: only the session bound to this owner is
    addressable.
    """
    _require_operator_token(request)
    session = registry.sessions_by_user_id.get(owner)
    if session is None or session.ended:
        raise HTTPException(404, f"no live session for owner={owner!r}")
    gate = registry.clear_gate(session, gate_id)  # raises UnknownGate
    await session.events.put({"type": P.GATE_CLEARED, "gate_id": gate_id})
    try:
        await session.companion.send({"type": P.GATE_CLEARED, "gate_id": gate_id})
    except Exception:  # noqa: BLE001 - companion may already be gone
        pass
    return JSONResponse({"gate_id": gate.gate_id, "status": "cleared"})


# ---------------------------------------------------------------------------
# §2 — /session/start, /session/stop, /session/gate, /session/events
# ---------------------------------------------------------------------------


def _require_operator_token(request: Request) -> None:
    """S3 hardening: the relay's control endpoints are owner-only and must
    never honor an anonymous caller. Fails closed — if RELAY_OPERATOR_TOKEN
    isn't configured, the endpoint refuses (503) rather than running open."""
    if not config.OPERATOR_TOKEN:
        raise OperatorTokenNotConfigured("RELAY_OPERATOR_TOKEN is not configured on the server")
    if request.headers.get("X-Operator-Token") != config.OPERATOR_TOKEN:
        raise BadOperatorToken("missing or invalid X-Operator-Token header")


@app.post("/session/start")
async def session_start(request: Request) -> JSONResponse:
    _require_operator_token(request)
    body = await request.json()
    pairing_token = body.get("pairing_token") or body.get("register_token")
    owner_claim = (body.get("owner") or "").strip() or None
    takeover = bool(request.query_params.get("takeover") == "true" or body.get("takeover"))

    # §2.3: the effective owner comes from the pairing token, or (for the
    # owner's own backend) from an owner that already has a live pairing.
    # A pairing token whose owner conflicts with the claimed owner is refused
    # here, in the relay — the client cannot talk its way past this.
    user_id = registry.resolve_owner(owner=owner_claim, pairing_token=pairing_token)
    if not user_id:
        if pairing_token:
            raise BadPairingToken("pairing token not recognized")
        raise HTTPException(400, "owner or pairing_token required")

    companion = registry.get_online_companion(user_id)  # raises CompanionNotOnline
    session = registry.start_session(user_id, companion, takeover)  # raises SessionConflict

    _start_session_timers(session)
    await companion.send({"type": P.SESSION_START, "session_id": session.session_id})

    return JSONResponse(
        {"session_id": session.session_id, "session_token": session.session_token, "owner": user_id}
    )


@app.post("/session/stop")
async def session_stop(request: Request) -> JSONResponse:
    _require_operator_token(request)
    body = await request.json()
    session_token = body.get("session_token")
    if not session_token:
        raise HTTPException(400, "session_token required")
    session = registry.get_session(session_token)  # raises UnknownSession
    await _teardown_session(session, P.REASON_COMPLETED)
    return JSONResponse({"status": "stopped", "session_id": session.session_id})


@app.post("/session/gate")
async def session_gate(request: Request) -> JSONResponse:
    _require_operator_token(request)
    body = await request.json()
    session_token = body.get("session_token")
    gate_id = body.get("gate_id") or f"g_{uuid.uuid4().hex[:8]}"
    kind = body.get("kind", "unknown")
    hint = body.get("hint", "")
    url_host = body.get("url_host", "")

    if not session_token:
        raise HTTPException(400, "session_token required")
    if kind not in P.GATE_KINDS:
        raise HTTPException(400, f"kind must be one of {sorted(P.GATE_KINDS)}")

    session = registry.get_session(session_token)  # raises UnknownSession
    gate = registry.open_gate(session, gate_id, kind, hint, url_host)
    gate.timeout_task = asyncio.create_task(_gate_timeout_watcher(session, gate))

    await session.companion.send(
        {"type": P.GATE_OPEN, "gate_id": gate_id, "kind": kind, "hint": hint, "url_host": url_host}
    )
    return JSONResponse({"gate_id": gate_id, "status": "open"}, status_code=202)


@app.get("/session/events/{session_token}")
async def session_events(session_token: str) -> StreamingResponse:
    """SSE push channel: GATE_CLEARED / GATE_TIMEOUT / SESSION_ENDED to the agent."""
    session = registry.get_session(session_token)  # raises UnknownSession

    async def _stream():
        while True:
            try:
                event = await asyncio.wait_for(session.events.get(), timeout=15.0)
            except TimeoutError:
                # C2: Cloudflare's ~100s idle timeout would otherwise drop a
                # silent gate-wait stream — a periodic SSE comment keeps it alive.
                yield ": keepalive\n\n"
                continue
            yield f"data: {json.dumps(event)}\n\n"
            if event.get("type") == P.SESSION_ENDED:
                return

    return StreamingResponse(_stream(), media_type="text/event-stream")


async def _teardown_session(session: Session, reason: str) -> None:
    for channel, send in list(session.companion.agent_ws_send.items()):
        try:
            await send({"__relay_close__": True})
        except Exception:  # noqa: BLE001 - best-effort close, session is ending regardless
            pass
    session.companion.agent_ws_send.clear()
    registry.end_session(session, reason)
    await session.events.put({"type": P.SESSION_ENDED, "session_id": session.session_id, "reason": reason})
    try:
        await session.companion.send(
            {"type": P.SESSION_ENDED, "session_id": session.session_id, "reason": reason}
        )
    except Exception:  # noqa: BLE001 - companion tunnel may already be gone (F1)
        pass


def _start_session_timers(session: Session) -> None:
    session.idle_task = asyncio.create_task(_idle_timeout_watcher(session))
    session.max_task = asyncio.create_task(_max_timeout_watcher(session))


async def _idle_timeout_watcher(session: Session) -> None:
    try:
        while not session.ended:
            await asyncio.sleep(5)
            if session.open_gate_ids:
                # C1: no CDP frames flow while a gate is open, by design —
                # GATE_TTL (not IDLE_TTL) governs this window instead.
                continue
            if time.time() - session.last_cdp_activity > config.IDLE_TTL_S:
                await _teardown_session(session, P.REASON_IDLE_TIMEOUT)
                return
    except asyncio.CancelledError:
        return


async def _max_timeout_watcher(session: Session) -> None:
    try:
        await asyncio.sleep(config.MAX_TTL_S)
        if not session.ended:
            await _teardown_session(session, P.REASON_MAX_TIMEOUT)
    except asyncio.CancelledError:
        return


async def _gate_timeout_watcher(session: Session, gate) -> None:
    try:
        await asyncio.sleep(config.GATE_TTL_S)
        if gate.cleared.is_set() or session.ended:
            return
        gate.timed_out = True
        session.open_gate_ids.discard(gate.gate_id)
        await session.events.put({"type": P.GATE_TIMEOUT, "gate_id": gate.gate_id})
        try:
            await session.companion.send({"type": P.GATE_TIMEOUT, "gate_id": gate.gate_id})
        except Exception:  # noqa: BLE001 - companion may already be gone
            pass
    except asyncio.CancelledError:
        return


@app.get("/session/gate/{session_token}/{gate_id}/wait")
async def session_gate_wait(session_token: str, gate_id: str) -> JSONResponse:
    """Convenience poll: block until this gate clears or times out.

    The push channel (/session/events) is the primary signal path; this is a
    simple poll-style alternative for callers that prefer request/response
    over SSE. One method, same underlying asyncio.Event — not a fallback.
    """
    session = registry.get_session(session_token)
    gate = registry.get_gate(session, gate_id)
    try:
        await asyncio.wait_for(gate.cleared.wait(), timeout=config.GATE_TTL_S)
        return JSONResponse({"type": P.GATE_CLEARED, "gate_id": gate_id})
    except TimeoutError:
        return JSONResponse({"type": P.GATE_TIMEOUT, "gate_id": gate_id})


# ---------------------------------------------------------------------------
# §1.1/§1.2 — /cdp/{session_token} HTTP discovery facade
# ---------------------------------------------------------------------------


def _rewrite_ws_host(body: object, session_token: str, new_scheme: str, new_host: str) -> object:
    """Rewrite webSocketDebuggerUrl host(s) to point back at the relay.

    This is the one CDP field the relay is allowed to parse (§5) — solely to
    extract the target path and rebuild it against the relay's own
    /cdp/{session_token}/devtools/... route. Everything else in the
    discovery body passes through untouched.
    """

    def rewrite_one(url: str) -> str:
        path = urlsplit(url).path  # e.g. "/devtools/browser/<id>"
        return f"{new_scheme}://{new_host}/cdp/{session_token}{path}"

    if isinstance(body, dict):
        out = dict(body)
        if isinstance(out.get("webSocketDebuggerUrl"), str):
            out["webSocketDebuggerUrl"] = rewrite_one(out["webSocketDebuggerUrl"])
        return out
    if isinstance(body, list):
        return [_rewrite_ws_host(item, session_token, new_scheme, new_host) for item in body]
    return body


async def _companion_http_rpc(session: Session, path: str) -> dict:
    companion = session.companion
    req_id = uuid.uuid4().hex[:12]
    fut: "asyncio.Future[dict]" = asyncio.get_event_loop().create_future()
    companion.pending_http[req_id] = fut
    try:
        await companion.send({"type": P.CDP_HTTP_REQ, "req_id": req_id, "path": path})
        return await asyncio.wait_for(fut, timeout=config.COMPANION_RPC_TIMEOUT_S)
    except TimeoutError as exc:
        raise CompanionUnresponsive(f"companion did not answer discovery GET {path!r} in time") from exc
    finally:
        companion.pending_http.pop(req_id, None)


@app.get("/cdp/{session_token}/json/version")
@app.get("/cdp/{session_token}/json/list")
async def cdp_discovery(session_token: str, request: Request) -> JSONResponse:
    session = registry.get_session(session_token)  # raises UnknownSession
    session.touch()
    path = "/json/version" if request.url.path.endswith("/json/version") else "/json/list"

    res = await _companion_http_rpc(session, path)  # {"status": int, "body": ...}
    status = res.get("status", 200)
    body = res.get("body")

    new_scheme = "wss" if request.url.scheme == "https" else "ws"
    new_host = request.url.netloc
    rewritten = _rewrite_ws_host(body, session_token, new_scheme, new_host)
    return JSONResponse(rewritten, status_code=status)


# ---------------------------------------------------------------------------
# §1.1/§1.3 — /cdp/{session_token}/devtools/... websocket multiplexing
# ---------------------------------------------------------------------------


@app.websocket("/cdp/{session_token}/devtools/{target_path:path}")
async def cdp_devtools_ws(websocket: WebSocket, session_token: str, target_path: str) -> None:
    try:
        session = registry.get_session(session_token)
    except RelayError:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    companion = session.companion
    channel = companion.allocate_channel()

    async def _send_to_agent(msg: dict) -> None:
        if msg.get("__relay_close__"):
            await websocket.close(code=1001)
            return
        await websocket.send_text(json.dumps(msg))

    companion.agent_ws_send[channel] = _send_to_agent

    open_fut: "asyncio.Future[None]" = asyncio.get_event_loop().create_future()
    companion.pending_ws_open[channel] = open_fut
    try:
        await companion.send(
            {"type": P.CDP_WS_OPEN, "channel": channel, "target_ws_path": f"/devtools/{target_path}"}
        )
        await asyncio.wait_for(open_fut, timeout=config.COMPANION_RPC_TIMEOUT_S)
    except TimeoutError:
        companion.agent_ws_send.pop(channel, None)
        companion.pending_ws_open.pop(channel, None)
        await websocket.close(code=4504)  # CompanionUnresponsive, see errors.py
        return
    finally:
        companion.pending_ws_open.pop(channel, None)

    try:
        while True:
            raw = await websocket.receive_text()
            session.touch()
            # §5: this json.loads is structural (to fit the CDP_WS_FRAME
            # envelope for multiplexing), not inspection — no field of the
            # decoded CDP message is read, logged, or branched on.
            data = json.loads(raw)
            await companion.send({"type": P.CDP_WS_FRAME, "channel": channel, "data": data})
    except WebSocketDisconnect:
        pass
    finally:
        companion.agent_ws_send.pop(channel, None)
        try:
            await companion.send({"type": P.CDP_WS_CLOSE, "channel": channel, "code": 1000})
        except Exception:  # noqa: BLE001 - companion tunnel may already be gone
            pass


# ---------------------------------------------------------------------------
# §1.3/§4.2/§4.3 — /companion/{pairing_token} tunnel
# ---------------------------------------------------------------------------


@app.websocket("/companion/{register_token}")
async def companion_tunnel(websocket: WebSocket, register_token: str) -> None:
    await websocket.accept()

    user_id = registry.resolve_register_token(register_token)
    if user_id is None:
        await websocket.send_text(json.dumps({"type": P.REGISTER_REJECT, "reason": "bad_token"}))
        await websocket.close(code=4401)
        return

    first_raw = await websocket.receive_text()
    first = json.loads(first_raw)
    if first.get("type") != P.REGISTER:
        await websocket.send_text(json.dumps({"type": P.REGISTER_REJECT, "reason": "expected_register"}))
        await websocket.close(code=4400)
        return

    async def _send_to_companion(msg: dict) -> None:
        await websocket.send_text(json.dumps(msg))

    companion = registry.register_companion(register_token, user_id, _send_to_companion)
    companion.websocket = websocket
    await websocket.send_text(
        json.dumps(
            {
                "type": P.REGISTER_OK,
                "user_id": user_id,
                "owner": user_id,
                "heartbeat_interval_s": config.HEARTBEAT_INTERVAL_S,
            }
        )
    )
    log.info("companion registered owner=%s", user_id)

    heartbeat_watch = asyncio.create_task(_heartbeat_watcher(companion))
    try:
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)
            await _dispatch_companion_message(companion, msg)
    except WebSocketDisconnect:
        log.info("companion tunnel closed owner=%s", user_id)
    finally:
        heartbeat_watch.cancel()
        bound_session = registry.unregister_companion(companion)
        if bound_session is not None and not bound_session.ended:
            await _teardown_session(bound_session, P.REASON_COMPANION_GONE)


async def _heartbeat_watcher(companion: Companion) -> None:
    """Force-close a tunnel that's stopped sending HEARTBEAT (F1, dead-peer case).

    A plain TCP half-open connection never raises WebSocketDisconnect on its
    own; this is what actually detects that case. Closing the websocket here
    makes `companion_tunnel`'s own receive loop raise WebSocketDisconnect and
    run the *one* existing teardown path (registry.unregister_companion +
    SESSION_ENDED{reason:"companion_gone"}) — no separate teardown logic.
    """
    try:
        while companion.online:
            await asyncio.sleep(config.HEARTBEAT_INTERVAL_S)
            if time.time() - companion.last_heartbeat > config.HEARTBEAT_MISS_LIMIT_S:
                log.warning(
                    "companion owner=%s missed heartbeat (last=%.0fs ago) — force-closing tunnel",
                    companion.user_id,
                    time.time() - companion.last_heartbeat,
                )
                try:
                    await companion.websocket.close(code=4408)
                except Exception:  # noqa: BLE001 - already gone, receive loop will observe it
                    pass
                return
    except asyncio.CancelledError:
        return


async def _dispatch_companion_message(companion: Companion, msg: dict) -> None:
    """Single dispatch point for every message type a companion may send.

    Unknown types are logged and ignored (clean no-op), never raised as an
    exception that would tear down the tunnel — a malformed/future message
    from one channel must not kill the whole companion connection.
    """
    msg_type = msg.get("type")

    if msg_type == P.HEARTBEAT:
        companion.last_heartbeat = time.time()
        return

    if msg_type == P.CDP_HTTP_RES:
        fut = companion.pending_http.get(msg.get("req_id"))
        if fut is not None and not fut.done():
            fut.set_result({"status": msg.get("status", 200), "body": msg.get("body")})
        return

    if msg_type == P.CDP_WS_OPEN_OK:
        fut = companion.pending_ws_open.get(msg.get("channel"))
        if fut is not None and not fut.done():
            fut.set_result(None)
        return

    if msg_type == P.CDP_WS_FRAME:
        channel = msg.get("channel")
        send = companion.agent_ws_send.get(channel)
        if send is not None:
            await send(msg.get("data"))
        return

    if msg_type == P.CDP_WS_CLOSE:
        channel = msg.get("channel")
        send = companion.agent_ws_send.pop(channel, None)
        if send is not None:
            await send({"__relay_close__": True})
        return

    if msg_type == P.GATE_CLEARED:
        session = registry.sessions_by_user_id.get(companion.user_id)
        if session is not None and not session.ended:
            gate_id = msg.get("gate_id")
            try:
                registry.clear_gate(session, gate_id)
            except RelayError:
                return
            await session.events.put({"type": P.GATE_CLEARED, "gate_id": gate_id})
        return

    log.warning("companion sent unknown message type=%r (ignored)", msg_type)


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "companions_online": len(registry.companions_by_user_id),
            "pairings": len(registry.pairings.owners()),
        }
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=config.HOST, port=config.PORT)
