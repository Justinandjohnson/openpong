# OpenPong Relay

Ported from the upstream OmniPong relay (Agent A). Implements
[`docs/RELAY_ARCHITECTURE.md`](../../../docs/RELAY_ARCHITECTURE.md): §1 transport,
§2 auth/lifecycle (incl. **per-user pairing**), §3 gate routing, §4 message
schemas, §5 security, §7 failure modes.

The relay lets OpenPong drive a **remote user's own, already-logged-in Chrome**
with **no credentials stored server-side** and a human-in-the-loop hand-back at
login/Cloudflare/2FA gates. It never sees page content, passwords, or the model
key — it forwards CDP bytes and pairing metadata only.

## Files

| File | Purpose |
|---|---|
| `server.py` | The FastAPI/ASGI app — every route and websocket handler. |
| `registry.py` | In-memory companions/sessions/gates + the persisted `PairingStore`. |
| `protocol.py` | Wire message `type` string constants (normative names from §4). |
| `errors.py` | One exception type per clean failure mode (§7); no fallback chains. |
| `config.py` | All tunables read from env vars, with documented defaults. |
| `test_relay.py` | Self-check — runs the real ASGI app end-to-end, no browser needed. |
| `register_tokens.example.json` | Optional static `{token: owner_id}` map to copy. |
| `run.sh` | Creates a venv, installs deps, starts the relay (Windows + macOS). |

## Per-user pairing (§2.3)

A companion is paired to **exactly one owner** through a revocable pairing
token, and `/session/start` refuses a session whose owner does not match the
pairing (403 `OwnerMismatch`). Minting/revoking is operator-gated:

```bash
# mint (returns the token once; only a fingerprint is shown afterwards)
curl -s -X POST localhost:8765/pairing \
  -H "X-Operator-Token: $RELAY_OPERATOR_TOKEN" \
  -H 'content-type: application/json' -d '{"owner":"u_123"}'

# status for the dashboard card
curl -s localhost:8765/companions/u_123 -H "X-Operator-Token: $RELAY_OPERATOR_TOKEN"

# revoke
curl -s -X DELETE localhost:8765/pairing/u_123 -H "X-Operator-Token: $RELAY_OPERATOR_TOKEN"

# "I handled it, continue"
curl -s -X POST localhost:8765/companions/u_123/gates/g_01/clear \
  -H "X-Operator-Token: $RELAY_OPERATOR_TOKEN"
```

## Running it

```bash
cd services/omnipong/relay
export RELAY_OPERATOR_TOKEN="$(openssl rand -hex 32)"   # required; control plane fails closed without it
./run.sh                                                 # uvicorn on 0.0.0.0:8765
```

Config (all env, see `config.py`): `RELAY_HOST`, `RELAY_PORT`,
`RELAY_IDLE_TTL_S`, `RELAY_MAX_TTL_S`, `RELAY_GATE_TTL_S`,
`RELAY_HEARTBEAT_INTERVAL_S`, `RELAY_COMPANION_RPC_TIMEOUT_S`,
`RELAY_PAIRINGS_FILE`, `RELAY_REGISTER_TOKENS_FILE`, `RELAY_OPERATOR_TOKEN`.

## Self-check (no browser, no companion process)

```bash
cd services/omnipong/relay
python -m pytest test_relay.py -v
```

This drives the real ASGI app through Starlette's `TestClient` — real WebSocket
handshakes, real HTTP requests, real asyncio timers — playing the companion role
itself over the wire, so every relay code path executes: register → reject-bad-token
→ pairing mint/revoke → session/start (incl. the 409 conflict and the 403
owner-mismatch) → CDP discovery GET + `webSocketDebuggerUrl` rewrite → devtools
websocket open + a fake CDP frame round trip → gate open/clear (both the
companion's Continue and the dashboard's clear) → session/stop → gate timeout.

## What is NOT verified

`test_relay.py` plays the companion role itself; it does not prove a real Chrome
with `--remote-debugging-port=9222` and a real companion binary interoperate
over the network. See `docs/RELAY_ARCHITECTURE.md` §7.5.
