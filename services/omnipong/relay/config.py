"""Relay configuration — all values overridable via environment variables.

One method to load config: read env vars at import time with documented
defaults. No fallback chains, no config file auto-discovery magic.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

# --- Timeouts (seconds). See RELAY_ARCHITECTURE.md §2.2 / §3.3. ---
IDLE_TTL_S = int(os.environ.get("RELAY_IDLE_TTL_S", "120"))
MAX_TTL_S = int(os.environ.get("RELAY_MAX_TTL_S", "900"))  # 15 min
GATE_TTL_S = int(os.environ.get("RELAY_GATE_TTL_S", "300"))  # 5 min
HEARTBEAT_INTERVAL_S = int(os.environ.get("RELAY_HEARTBEAT_INTERVAL_S", "20"))
# A companion is considered gone if it misses 2x the heartbeat interval.
HEARTBEAT_MISS_LIMIT_S = HEARTBEAT_INTERVAL_S * 2

# Timeout waiting for a companion to answer a proxied CDP HTTP discovery GET
# or a CDP_WS_OPEN_OK ack. This is a relay<->companion round trip over an
# already-open tunnel, so it should be fast; a generous ceiling avoids
# hanging agent-side HTTP calls forever if the companion tunnel is stalled.
COMPANION_RPC_TIMEOUT_S = float(os.environ.get("RELAY_COMPANION_RPC_TIMEOUT_S", "10"))

# --- Pairing tokens (per-user identity). ---
# A pairing token is bound to exactly ONE owner (docs/RELAY_ARCHITECTURE.md
# §2.3). Two sources, merged at startup:
#   1. Static provisioning: RELAY_REGISTER_TOKENS_FILE, a JSON object
#      {"rt_...": "owner_id", ...} (kept for backward compatibility with the
#      upstream relay and for deployments that provision tokens out-of-band).
#   2. Dynamic minting: RELAY_PAIRINGS_FILE, a JSON object {"rt_...":
#      "owner_id", ...} that POST /pairing appends to and DELETE /pairing/{owner}
#      prunes. This is the file the dashboard's pairing flow writes through.
# No fallback to guessing / auto-provisioning tokens.
REGISTER_TOKENS_FILE = os.environ.get(
    "RELAY_REGISTER_TOKENS_FILE",
    str(Path(__file__).parent / "register_tokens.json"),
)
PAIRINGS_FILE = os.environ.get(
    "RELAY_PAIRINGS_FILE",
    str(Path(__file__).parent / "pairings.json"),
)


def load_register_tokens() -> dict[str, str]:
    """Static owner map: {token: owner_id}. Missing file means no static tokens."""
    return _load_owner_map(REGISTER_TOKENS_FILE)


def _load_owner_map(path_str: str) -> dict[str, str]:
    path = Path(path_str)
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object of {{token: owner_id}}")
    return {str(k): str(v) for k, v in data.items()}


HOST = os.environ.get("RELAY_HOST", "0.0.0.0")
PORT = int(os.environ.get("RELAY_PORT", "8765"))

# --- Operator gate (S3 hardening, owner-only posture). ---
# The relay's control endpoints (/session/start, /session/stop, /session/gate,
# /pairing, /companions/*) are a control plane meant for the owner's own
# backend/companion only — never anonymous callers. No default: unset means the
# gate fails closed (server.py refuses with 503) rather than running open.
#
# With multiple users this token stays a single control-plane secret; per-user
# identity comes from the pairing binding (a companion is paired to exactly one
# owner and /session/start refuses an owner that does not match its pairing).
OPERATOR_TOKEN = os.environ.get("RELAY_OPERATOR_TOKEN")
