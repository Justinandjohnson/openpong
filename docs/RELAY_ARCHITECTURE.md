# OpenPong Relay Architecture

**Status:** Implemented (`services/omnipong/relay` + `services/omnipong/companion`).
**Adapted from:** the upstream OmniPong relay spec (Apache-2.0), with one
substantive change — **per-user pairing** — described in §2.3.

This document explains how OpenPong drives a user's **own, already-logged-in
Chrome** with **no credentials stored anywhere server-side**, and with a
human-in-the-loop hand-back at login / Cloudflare / 2FA / captcha gates.

The relay never sees a password, a cookie, an OTP, or page content. It carries
CDP bytes and pairing metadata, nothing else.

---

## 1. Transport — the relay forwards CDP

CDP over a remote connection is **not** a single WebSocket. A DevTools client
(Playwright's `connect_over_cdp`, and browser-use's `cdp_url`) bootstraps in two
steps:

1. **HTTP discovery** — `GET http://<host>:9222/json/version` (and sometimes
   `/json/list`) to read the browser-level `webSocketDebuggerUrl`.
2. **WebSocket** — connect to that `webSocketDebuggerUrl` and speak CDP frames.

So the relay's per-session endpoint proxies **both**: the HTTP discovery JSON
**and** the DevTools WebSocket. It also **rewrites** the `webSocketDebuggerUrl`
host in the discovery response so it points back at the relay (not at the
user's `localhost:9222`, which the server cannot reach).

### 1.1 What the caller passes

```
cdp_url = "https://relay.example/cdp/{session_token}"
```

- The domain service (or browser agent) hands this to Playwright/browser-use.
- `GET /cdp/{token}/json/version` and `/json/list` → the relay asks the
  companion to GET its own `localhost:9222/json/*`, returns it with the ws host
  rewritten to `wss://relay…/cdp/{token}/devtools/...`.
- `WS /cdp/{token}/devtools/{target_path}` → the relay upgrades and pipes CDP
  frames ↔ the companion tunnel ↔ the companion's local ws to Chrome.

### 1.2 Companion tunnel multiplexing

The companion opens exactly **one** outbound
`wss://relay…/companion/{pairing_token}`. All server-initiated CDP (discovery
HTTP + N devtools websockets) is multiplexed inside that one tunnel using a
framing envelope (§4). The user's machine never exposes `9222` to the internet.

### 1.3 Why the domain service uses it too

`services/omnipong/browser_backend.py` selects a browser backend by env:

- `OMNIPONG_BROWSER=relay` → connect Playwright over CDP to
  `{RELAY_URL}/cdp/{session_token}` and run the existing page-interaction code
  against the user's real browser. No credential is read.
- `OMNIPONG_BROWSER=local` (default) → the original local Playwright profile.
  Its stored-credential path is **opt-in only** (`OMNIPONG_ALLOW_STORED_CREDENTIALS=true`).

---

## 2. Auth & session lifecycle (no credentials, ever)

**Principle:** the relay authenticates *tunnels and sessions*, never *user site
credentials*. It never sees an OmniPong/Stadium/USATT password — the user is
already logged in inside their own Chrome; the relay only forwards CDP bytes.

### 2.1 Tokens

| Token | Issued to | Scope | Lifetime |
|---|---|---|---|
| `pairing_token` (wire field `register_token`) | The companion, out-of-band (the dashboard mints it and the person pastes it) | "This companion may register as owner O" | Long-lived per install; revocable |
| `session_token` | Minted by the relay on `/session/start` | "This one CDP session for owner O's browser" | Single session; dies on stop/timeout |
| `operator_token` (`RELAY_OPERATOR_TOKEN`) | The owner's own backend/dashboard | "May call the relay's control plane" | Long-lived shared secret; fails closed when unset |

No site password, no cookie, and no model API key is stored in the relay.

### 2.2 Lifecycle

```
register  companion --WS--> relay/companion/{pairing_token}
                             relay: resolve token -> owner, mark ONLINE
start     backend --POST relay/session/start {owner | pairing_token}
                             relay: resolve effective owner, bind to that owner's
                                    online companion, mint session_token
                                    (one browser per owner: 409 unless takeover)
attach    Playwright/Browser(cdp_url=relay/cdp/{session_token}) -> CDP over tunnel
gate      see §3
stop      backend --POST relay/session/stop {session_token}
timeout   idle > RELAY_IDLE_TTL_S (120s) or total > RELAY_MAX_TTL_S (900s)
cleanup   companion WS closes -> relay reaps the bound session immediately
```

### 2.3 Per-user pairing (the OpenPong change)

Upstream, the relay had a single-owner control token and a `register_token →
user_id` map. That collapses when several people share one relay. In OpenPong:

- **A companion is paired to exactly ONE owner.** The pairing token is minted
  for that owner (`POST /pairing {owner}`, operator-gated), stored in
  `RELAY_PAIRINGS_FILE`, and revocable (`DELETE /pairing/{owner}`).
- **The relay refuses a session whose owner does not match the pairing.**
  `/session/start` resolves the effective owner from the pairing token and, if
  the caller also claims an `owner`, returns **403 `OwnerMismatch`** when they
  differ. This is enforced *in the relay*, not only in the client.
- **`/session/start` with only an `owner`** (no pairing token) is allowed for
  the owner's own backend, but only if that owner actually has a pairing
  (otherwise 404 `PairingNotFound`). The relay never mints a session for an
  owner with no paired companion.
- The operator token stays a single control-plane secret; **identity is
  per-owner** through the pairing binding. `GET /companions/{owner}` and
  `POST /companions/{owner}/gates/{gate_id}/clear` are always owner-scoped.

Timeouts (defaults): `IDLE_TTL = 120s` with no CDP frames →
`SESSION_ENDED{reason:"idle_timeout"}`; `MAX_TTL = 900s` hard cap;
`GATE_TTL = 300s` unsolved gate. All are clean errors, no retries.

---

## 3. The `wait_for_human` gate handshake

When the agent hits a login page, Cloudflare interstitial, captcha, or 2FA
prompt, it stops touching the browser, asks the **remote user** to solve it in
their own Chrome, and resumes only when the user says "done".

```
Agent                     Relay                     Companion (user machine)     User
  | detect gate             |                              |                       |
  | pause                   |                              |                       |
  | POST /session/gate ---> | GATE_OPEN ----------------->  | show prompt ---------> | sees "Log in, then Continue"
  |                         |                              |                       | solves it IN THEIR OWN BROWSER
  |                         | <---------------- GATE_CLEARED (gate_id)              |
  | <---- GATE_CLEARED ---- |                              |                       |
  | resume                  |                              |                       |
```

The user solves the gate directly in their own Chrome tab. Only the *fact*
"gate cleared" (a `gate_id`) travels back — never a credential.

**Two ways to clear a gate**, both backed by the same primitive:
1. The user clicks **Continue** in the companion's local prompt (a stdlib
   `127.0.0.1` page, CSRF-protected with a per-gate nonce).
2. The dashboard's **"I handled it, continue"** action calls
   `POST /companions/{owner}/gates/{gate_id}/clear`; the relay clears the gate,
   tells the companion to close its prompt, and wakes the agent's event stream.

Timeout: if no `GATE_CLEARED` within `GATE_TTL`, the relay emits
`GATE_TIMEOUT`; the agent does **not** resume. No fallback, no auto-solve, no
captcha service.

---

## 4. Message schemas (JSON, both directions)

All relay messages are JSON objects with a `type`. Transport is the companion
tunnel WS and the agent's control calls (`/session/*` POST + `/session/events`
SSE). Field names are normative.

```json
// Companion -> Relay, on tunnel open
{ "type": "REGISTER", "register_token": "rt_…", "companion_version": "0.2.0",
  "chrome_debug_port": 9222, "platform": "darwin" }
// Relay -> Companion
{ "type": "REGISTER_OK", "user_id": "owner", "owner": "owner", "heartbeat_interval_s": 20 }
{ "type": "REGISTER_REJECT", "reason": "bad_token" }
{ "type": "SESSION_START", "session_id": "s_…" }
{ "type": "SESSION_ENDED", "session_id": "s_…", "reason": "completed | idle_timeout | max_timeout | gate_timeout | agent_error | companion_gone | takeover" }
{ "type": "HEARTBEAT" }

// CDP tunnel frames
{ "type": "CDP_HTTP_REQ", "req_id": "h1", "path": "/json/version" }
{ "type": "CDP_HTTP_RES", "req_id": "h1", "status": 200, "body": { } }
{ "type": "CDP_WS_OPEN", "channel": 1, "target_ws_path": "/devtools/browser/<id>" }
{ "type": "CDP_WS_OPEN_OK", "channel": 1 }
{ "type": "CDP_WS_FRAME", "channel": 1, "data": { "id": 7, "method": "Page.navigate", "params": {} } }
{ "type": "CDP_WS_CLOSE", "channel": 1, "code": 1000 }

// Gate handshake
{ "type": "GATE_OPEN", "gate_id": "g_01", "kind": "login | cloudflare | captcha | twofa | unknown",
  "hint": "Log in, then click Continue", "url_host": "omnipong.com" }
{ "type": "GATE_CLEARED", "gate_id": "g_01" }
{ "type": "GATE_TIMEOUT", "gate_id": "g_01" }
```

`url_host` is host-only by policy: never a full URL with query params/tokens.

---

## 5. Security boundaries

**What the relay CAN see**
- Tunnel/session metadata: owner id, tokens (never returned after minting
  except a short fingerprint), timestamps, heartbeats, gate `kind`/`url_host`,
  byte counts.
- The CDP **discovery** JSON (`/json/version`) — enough to rewrite
  `webSocketDebuggerUrl`.

**What the relay CANNOT / MUST NOT see or store**
- **No site credentials** — the user logs in themselves; passwords/OTP never
  leave the user's browser.
- **No model API key** — it goes frontend → backend → browser agent in-process;
  it never transits the relay path.
- **Page content is opaque.** `CDP_WS_FRAME.data` is forwarded byte-for-byte;
  the relay does not parse, log, or persist DOM/screenshots/response bodies.
- **No full URLs with query strings** in any relay-visible field — host only.

**Isolation & exposure**
- **Per-owner isolation:** one `session_token` ⇒ one companion ⇒ one browser.
  A token cannot address another owner's tunnel. Channel demux is per-session.
- **`9222` is never exposed to the internet.** The user's Chrome listens only on
  `localhost:9222`; the sole network egress is the companion's outbound WS.
- **The CDP endpoint is not public:** `/cdp/{session_token}` is unguessable and
  single-session. The control plane fails closed (503) when
  `RELAY_OPERATOR_TOKEN` is unset.

### Threat model

| Adversary | Capability | Mitigation |
|---|---|---|
| Anonymous internet caller | Can reach the relay's HTTP/WS ports | Every control endpoint requires `X-Operator-Token`; `/companion/{token}` requires a high-entropy pairing token; `/cdp/{token}` requires a single-session token |
| Another OpenPong owner | Has their own account/session | The relay binds a session to the pairing's owner and refuses `OwnerMismatch`; the dashboard only ever names the session's owner |
| A leaked pairing token | Can register a companion for that one owner | Revocable (`DELETE /pairing/{owner}`); rotates on re-mint; scoped to one owner; only a fingerprint is shown afterwards |
| A malicious page the agent visits | Controls DOM content | Content is data, not instructions; the agent is told never to obey page text; the relay never inspects it |
| Server compromise (relay) | Reads relay memory | Only pairing tokens, session tokens, gate metadata and opaque CDP frames are present — no passwords, no cookies, no page content |

---

## 6. Failure modes (each a clean, single-path failure)

| # | Failure | Detected by | Behavior |
|---|---|---|---|
| F1 | Companion disconnects mid-scrape | Tunnel close / missed heartbeats (2× interval) | Relay force-stops the session, emits `SESSION_ENDED{reason:"companion_gone"}`. No auto-reconnect-and-resume. |
| F2 | Gate never solved | `GATE_TTL` | `GATE_TIMEOUT` → agent ends with `GateNotSolved`. No captcha-solver fallback. |
| F3 | CDP connection drops | CDP call raises / unexpected close | Agent ends with `CdpLost`; relay reaps the session. |
| F4 | Model error | LLM call raises | Fails loudly with the status; no model fallback storm. |
| F5 | Two sessions for one owner | `/session/start` | 409 `SessionConflict` unless `?takeover=true`. |
| F6 | Relay unreachable | Connect fails | Clean `RelayUnreachable` before any scrape. |
| F7 | No companion connected | `/session/start` | 404 `CompanionNotOnline` → the domain service returns the typed `no_companion_connected` error: *"No companion connected — open OpenPong on your computer and pair it."* |

---

## 7. How to run it

### 7.1 Relay (once, wherever the server runs)

```bash
cd services/omnipong/relay
export RELAY_OPERATOR_TOKEN="$(openssl rand -hex 32)"   # 32+ chars
./run.sh                                                # creates a venv, starts uvicorn on :8765
```

`RELAY_HOST`, `RELAY_PORT`, `RELAY_IDLE_TTL_S`, `RELAY_MAX_TTL_S`,
`RELAY_GATE_TTL_S`, `RELAY_PAIRINGS_FILE`, `RELAY_REGISTER_TOKENS_FILE` are all
env-overridable (see `relay/config.py`).

### 7.2 Point the app + domain service at the relay

```
RELAY_URL=https://relay.example
RELAY_TOKEN=<the same RELAY_OPERATOR_TOKEN>
RELAY_OWNER=<the owner this single-owner domain service drives>
OMNIPONG_BROWSER=relay
```

The dashboard server reads `RELAY_URL`/`RELAY_TOKEN` for the "Your computer"
card; the domain service reads `OMNIPONG_BROWSER`/`RELAY_OWNER` too.

### 7.3 Pair the person's computer

1. In the dashboard, open **Settings → Your computer** and press
   **Pair this computer**. Copy the command.
2. On the computer that stays logged in to OmniPong:

```bash
cd services/omnipong/companion
pip install -r requirements.txt
python companion.py --relay-base-url wss://relay.example --pairing-token rt_…
```

The companion launches (or reuses) a **dedicated** Chrome profile with remote
debugging on `localhost:9222`. Log in to OmniPong once in that window. The card
turns **Connected**.

### 7.4 Verify a run

```bash
# Relay self-check (no browser): protocol, pairing, owner-mismatch, TTLs
cd services/omnipong/relay && python -m pytest test_relay.py -v

# Companion integration against a FAKE CDP endpoint + fake relay
cd services/omnipong/companion && python -m pytest test_companion.py -v

# Domain-service seam: relay mode never reads .credentials.json; typed no-companion error
cd services/omnipong && python -m pytest tests/test_browser_backend.py -v
```

Then, with a real companion connected, the manual runbook is: start a private
sync from the dashboard (or `POST /tools/sync/omnipong`), watch for a gate
prompt, solve it in your own Chrome, click **Continue** (companion) or
**I handled it, continue** (dashboard), and confirm the receipt.

### 7.5 What is NOT verified in CI

The Python and TS test suites use a **fake CDP endpoint** and a **fake relay**
— they prove the relay's logic, the companion's protocol behaviour, and the
domain-service seam. They do **not** prove a real Chrome + real
`--remote-debugging-port=9222` + a real companion binary interoperate over the
network. Run §7.4 with a real companion before relying on it.
