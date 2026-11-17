"""Self-check for the OpenPong relay — runs the real ASGI app in-process
(Starlette's TestClient, which drives real WebSocket handshakes and real HTTP
requests against `server.app`, no mocked internals) and exercises the full
register -> session/start -> CDP discovery -> CDP devtools frame ->
session/stop path end-to-end, plus the per-user pairing rules (§2.3).

This is intentionally NOT a real browser and NOT a real second machine: it
plays the companion role itself over a WebSocket, exactly the way a real
companion process would, so every relay code path (tunnel dispatch, HTTP
discovery proxy + rewrite, devtools channel multiplex, gate handshake,
session teardown, owner-mismatch refusal) actually executes. What it does NOT
prove is documented at the bottom of this file and in the build report.

Run directly:
    python -m pytest test_relay.py -v
"""

from __future__ import annotations

import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import config
import protocol as P
import pytest
import server
from registry import PairingStore
from starlette.testclient import TestClient

REGISTER_TOKEN = "rt_test_token_0001"
USER_ID = "u_test_0001"
OTHER_USER_ID = "u_test_0002"

# S3 hardening: /session/start, /session/stop, /session/gate and the pairing
# endpoints require an operator token (RELAY_OPERATOR_TOKEN / X-Operator-Token
# header, server.py's _require_operator_token). Tests that exercise those
# endpoints send this header; a handful specifically exercise the gate itself
# (missing header, unconfigured token) without it.
OPERATOR_TOKEN = "op_test_token_0001"
OP_HEADERS = {"X-Operator-Token": OPERATOR_TOKEN}


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setattr(config, "OPERATOR_TOKEN", OPERATOR_TOKEN)
    # Never write into the repo during a test: the mint/revoke endpoints
    # persist to this file.
    monkeypatch.setattr(config, "PAIRINGS_FILE", str(tmp_path / "pairings.json"))
    # Enter the TestClient context first — this fires the FastAPI startup
    # event, which loads the pairing store. Only after that do we inject the
    # test token, so it isn't clobbered by the startup reload.
    with TestClient(server.app) as c:
        server.registry.load_pairings({REGISTER_TOKEN: USER_ID})
        yield c
    # Reset shared registry state between tests.
    server.registry.__init__()  # type: ignore[misc]


def test_health(client: TestClient):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_register_reject_bad_token(client: TestClient):
    with client.websocket_connect("/companion/rt_totally_bogus") as ws:
        msg = json.loads(ws.receive_text())
        assert msg["type"] == P.REGISTER_REJECT
        assert msg["reason"] == "bad_token"


def test_session_start_requires_online_companion(client: TestClient):
    resp = client.post("/session/start", json={"owner": USER_ID}, headers=OP_HEADERS)
    assert resp.status_code == 404
    assert resp.json()["error"]["type"] == "CompanionNotOnline"


def test_session_start_rejects_unknown_owner_without_pairing(client: TestClient):
    """§2.3: an owner with no pairing token cannot mint a session — there is
    nothing a companion could have paired to."""
    resp = client.post("/session/start", json={"owner": "u_nobody"}, headers=OP_HEADERS)
    assert resp.status_code == 404
    assert resp.json()["error"]["type"] == "PairingNotFound"


def test_session_start_requires_operator_token(client: TestClient):
    """S3: /session/start is owner-only — no operator header, no session."""
    resp = client.post("/session/start", json={"owner": USER_ID})
    assert resp.status_code == 401
    assert resp.json()["error"]["type"] == "BadOperatorToken"


def test_session_start_fails_closed_when_operator_token_unconfigured(
    monkeypatch: pytest.MonkeyPatch, client: TestClient
):
    """S1/S3: if RELAY_OPERATOR_TOKEN is unset, control endpoints must refuse
    (503) rather than run open — even with a header supplied."""
    monkeypatch.setattr(config, "OPERATOR_TOKEN", None)
    resp = client.post("/session/start", json={"owner": USER_ID}, headers=OP_HEADERS)
    assert resp.status_code == 503
    assert resp.json()["error"]["type"] == "OperatorTokenNotConfigured"


def _register_companion(ws, token: str) -> dict:
    ws.send_text(
        json.dumps(
            {
                "type": P.REGISTER,
                "register_token": token,
                "companion_version": "0.2.0-test",
                "chrome_debug_port": 9222,
                "platform": "darwin",
            }
        )
    )
    return json.loads(ws.receive_text())


def test_owner_mismatch_is_refused_in_the_relay(client: TestClient):
    """§2.3, the load-bearing per-user rule: a session whose claimed owner
    does not match the pairing token's owner is refused with 403, even though
    the caller holds a valid operator token."""
    with client.websocket_connect(f"/companion/{REGISTER_TOKEN}") as companion_ws:
        reg_ok = _register_companion(companion_ws, REGISTER_TOKEN)
        assert reg_ok["type"] == P.REGISTER_OK
        assert reg_ok["owner"] == USER_ID

        mismatch = client.post(
            "/session/start",
            json={"owner": OTHER_USER_ID, "register_token": REGISTER_TOKEN},
            headers=OP_HEADERS,
        )
        assert mismatch.status_code == 403
        assert mismatch.json()["error"]["type"] == "OwnerMismatch"
        # And nothing was minted.
        assert server.registry.sessions_by_user_id.get(OTHER_USER_ID) is None


def test_matching_pairing_token_and_owner_starts_a_session(client: TestClient):
    with client.websocket_connect(f"/companion/{REGISTER_TOKEN}") as companion_ws:
        _register_companion(companion_ws, REGISTER_TOKEN)
        resp = client.post(
            "/session/start",
            json={"owner": USER_ID, "register_token": REGISTER_TOKEN},
            headers=OP_HEADERS,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["owner"] == USER_ID


def test_pairing_mint_and_revoke(client: TestClient):
    minted = client.post("/pairing", json={"owner": "u_pair_me"}, headers=OP_HEADERS)
    assert minted.status_code == 201, minted.text
    body = minted.json()
    assert body["owner"] == "u_pair_me"
    assert body["pairing_token"].startswith("rt_")
    assert body["fingerprint"] and body["pairing_token"] not in body["fingerprint"]

    # The freshly minted token can register a companion for exactly its owner.
    with client.websocket_connect(f"/companion/{body['pairing_token']}") as ws:
        reg_ok = _register_companion(ws, body["pairing_token"])
        assert reg_ok["owner"] == "u_pair_me"

        status = client.get("/companions/u_pair_me", headers=OP_HEADERS)
        assert status.json()["paired"] is True
        assert status.json()["connected"] is True

        revoked = client.delete("/pairing/u_pair_me", headers=OP_HEADERS)
        assert revoked.json() == {"owner": "u_pair_me", "revoked": True}
        # A revoked pairing can no longer start a session for that owner.
        gone = client.post("/session/start", json={"owner": "u_pair_me"}, headers=OP_HEADERS)
        assert gone.status_code == 404
        assert gone.json()["error"]["type"] == "PairingNotFound"


def test_pairing_endpoints_require_operator_token(client: TestClient):
    assert client.post("/pairing", json={"owner": USER_ID}).status_code == 401
    assert client.delete(f"/pairing/{USER_ID}").status_code == 401
    assert client.get(f"/companions/{USER_ID}").status_code == 401
    assert (
        client.post(f"/companions/{USER_ID}/gates/g_1/clear").status_code == 401
    )


def test_pairing_store_persists_and_rotates(tmp_path):
    """The one piece of relay state that must survive a restart."""
    path = tmp_path / "pairings.json"
    store = PairingStore(str(path))
    store.load({"rt_static": "u_static"})
    assert store.resolve("rt_static") == "u_static"

    first = store.mint("u_dynamic")
    assert store.resolve(first) == "u_dynamic"
    reloaded = PairingStore(str(path))
    reloaded.load({})
    assert reloaded.resolve(first) == "u_dynamic"

    # Re-minting rotates the token and drops the old one.
    second = store.mint("u_dynamic")
    assert second != first
    assert store.resolve(first) is None
    assert store.resolve(second) == "u_dynamic"

    assert store.revoke("u_dynamic") is True
    assert store.revoke("u_dynamic") is False
    assert store.resolve(second) is None


def test_full_happy_path_register_session_cdp_stop(client: TestClient):
    with client.websocket_connect(f"/companion/{REGISTER_TOKEN}") as companion_ws:
        reg_ok = _register_companion(companion_ws, REGISTER_TOKEN)
        assert reg_ok["type"] == P.REGISTER_OK
        assert reg_ok["user_id"] == USER_ID
        assert reg_ok["heartbeat_interval_s"] == config.HEARTBEAT_INTERVAL_S

        # --- /session/start ---
        resp = client.post("/session/start", json={"owner": USER_ID}, headers=OP_HEADERS)
        assert resp.status_code == 200, resp.text
        session = resp.json()
        session_token = session["session_token"]
        assert session["session_id"].startswith("s_")
        assert session_token.startswith("st_")

        session_start_msg = json.loads(companion_ws.receive_text())
        assert session_start_msg == {"type": P.SESSION_START, "session_id": session["session_id"]}

        # --- second session for same owner without takeover -> 409 ---
        conflict = client.post("/session/start", json={"owner": USER_ID}, headers=OP_HEADERS)
        assert conflict.status_code == 409
        assert conflict.json()["error"]["type"] == "SessionConflict"

        # --- CDP HTTP discovery facade (§1.1/§1.2), fake companion answers ---
        with ThreadPoolExecutor(max_workers=1) as pool:
            fut = pool.submit(client.get, f"/cdp/{session_token}/json/version")

            discovery_req = json.loads(companion_ws.receive_text())
            assert discovery_req["type"] == P.CDP_HTTP_REQ
            assert discovery_req["path"] == "/json/version"

            fake_chrome_body = {
                "Browser": "Chrome/999.0.0.0",
                "webSocketDebuggerUrl": "ws://localhost:9222/devtools/browser/FAKE-BROWSER-ID",
            }
            companion_ws.send_text(
                json.dumps(
                    {
                        "type": P.CDP_HTTP_RES,
                        "req_id": discovery_req["req_id"],
                        "status": 200,
                        "body": fake_chrome_body,
                    }
                )
            )
            discovery_resp = fut.result(timeout=5)

        assert discovery_resp.status_code == 200
        rewritten = discovery_resp.json()
        # Load-bearing assertion: host rewritten to the relay, path preserved,
        # session_token folded into the relay path (§1.1).
        assert rewritten["webSocketDebuggerUrl"] == (
            f"ws://testserver/cdp/{session_token}/devtools/browser/FAKE-BROWSER-ID"
        )
        assert rewritten["Browser"] == "Chrome/999.0.0.0"  # untouched passthrough field

        # --- CDP devtools websocket multiplex (§1.3/§4.3) ---
        devtools_path = f"/cdp/{session_token}/devtools/browser/FAKE-BROWSER-ID"
        with client.websocket_connect(devtools_path) as agent_ws:
            ws_open = json.loads(companion_ws.receive_text())
            assert ws_open["type"] == P.CDP_WS_OPEN
            assert ws_open["channel"] == 1
            assert ws_open["target_ws_path"] == "/devtools/browser/FAKE-BROWSER-ID"
            companion_ws.send_text(json.dumps({"type": P.CDP_WS_OPEN_OK, "channel": 1}))

            cdp_command = {"id": 7, "method": "Page.navigate", "params": {"url": "https://example.com"}}
            agent_ws.send_text(json.dumps(cdp_command))

            frame_out = json.loads(companion_ws.receive_text())
            assert frame_out["type"] == P.CDP_WS_FRAME
            assert frame_out["channel"] == 1
            assert frame_out["data"] == cdp_command  # forwarded byte-for-byte, unmodified (§5)

            cdp_reply = {"id": 7, "result": {"frameId": "FAKE-FRAME"}}
            companion_ws.send_text(
                json.dumps({"type": P.CDP_WS_FRAME, "channel": 1, "data": cdp_reply})
            )
            reply_in = json.loads(agent_ws.receive_text())
            assert reply_in == cdp_reply

            # --- gate handshake round trip (§3/§4.4), independent of the CDP channel ---
            gate_resp = client.post(
                "/session/gate",
                json={
                    "session_token": session_token,
                    "gate_id": "g_test_1",
                    "kind": "login",
                    "hint": "Log in to OmniPong, then click Continue",
                    "url_host": "omnipong.com",
                },
                headers=OP_HEADERS,
            )
            assert gate_resp.status_code == 202

            gate_open = json.loads(companion_ws.receive_text())
            assert gate_open == {
                "type": P.GATE_OPEN,
                "gate_id": "g_test_1",
                "kind": "login",
                "hint": "Log in to OmniPong, then click Continue",
                "url_host": "omnipong.com",
            }

            # Owner-scoped dashboard view lists the open gate.
            status = client.get(f"/companions/{USER_ID}", headers=OP_HEADERS)
            gates = status.json()["gates"]
            assert [g["gate_id"] for g in gates] == ["g_test_1"]
            assert gates[0]["kind"] == "login"

            companion_ws.send_text(json.dumps({"type": P.GATE_CLEARED, "gate_id": "g_test_1"}))

            wait_resp = client.get(f"/session/gate/{session_token}/g_test_1/wait")
            assert wait_resp.json() == {"type": P.GATE_CLEARED, "gate_id": "g_test_1"}

            # --- /session/stop tears everything down cleanly ---
            stop_resp = client.post("/session/stop", json={"session_token": session_token}, headers=OP_HEADERS)
            assert stop_resp.status_code == 200
            assert stop_resp.json()["status"] == "stopped"

            session_ended = json.loads(companion_ws.receive_text())
            assert session_ended == {
                "type": P.SESSION_ENDED,
                "session_id": session["session_id"],
                "reason": P.REASON_COMPLETED,
            }

            with pytest.raises(Exception):
                agent_ws.receive_text()

        after = client.get(f"/cdp/{session_token}/json/version")
        assert after.status_code == 404
        assert after.json()["error"]["type"] == "UnknownSession"


def test_dashboard_clear_gate_unblocks_the_agent(client: TestClient):
    """The "I handled it, continue" path: the relay clears the gate, tells the
    companion to close its prompt, and the agent's poll sees GATE_CLEARED."""
    with client.websocket_connect(f"/companion/{REGISTER_TOKEN}") as companion_ws:
        _register_companion(companion_ws, REGISTER_TOKEN)
        resp = client.post("/session/start", json={"owner": USER_ID}, headers=OP_HEADERS)
        session_token = resp.json()["session_token"]
        json.loads(companion_ws.receive_text())  # SESSION_START

        client.post(
            "/session/gate",
            json={
                "session_token": session_token,
                "gate_id": "g_dash",
                "kind": "twofa",
                "hint": "Enter your code",
                "url_host": "omnipong.com",
            },
            headers=OP_HEADERS,
        )
        json.loads(companion_ws.receive_text())  # GATE_OPEN

        cleared = client.post(
            f"/companions/{USER_ID}/gates/g_dash/clear", headers=OP_HEADERS
        )
        assert cleared.status_code == 200
        assert cleared.json() == {"gate_id": "g_dash", "status": "cleared"}

        # Companion is told to close its prompt.
        to_companion = json.loads(companion_ws.receive_text())
        assert to_companion == {"type": P.GATE_CLEARED, "gate_id": "g_dash"}

        # The agent's bounded poll observes the clearance.
        wait = client.get(f"/session/gate/{session_token}/g_dash/wait")
        assert wait.json() == {"type": P.GATE_CLEARED, "gate_id": "g_dash"}


def test_gate_timeout_short_ttl(monkeypatch: pytest.MonkeyPatch, client: TestClient):
    """GATE_TTL fires and emits GATE_TIMEOUT if the companion never clears it."""
    monkeypatch.setattr(config, "GATE_TTL_S", 1)

    with client.websocket_connect(f"/companion/{REGISTER_TOKEN}") as companion_ws:
        _register_companion(companion_ws, REGISTER_TOKEN)

        resp = client.post("/session/start", json={"owner": USER_ID}, headers=OP_HEADERS)
        session_token = resp.json()["session_token"]
        json.loads(companion_ws.receive_text())  # SESSION_START

        client.post(
            "/session/gate",
            json={
                "session_token": session_token,
                "gate_id": "g_timeout",
                "kind": "cloudflare",
                "hint": "solve it",
                "url_host": "example.com",
            },
            headers=OP_HEADERS,
        )
        json.loads(companion_ws.receive_text())  # GATE_OPEN

        wait_resp = client.get(f"/session/gate/{session_token}/g_timeout/wait")
        assert wait_resp.json()["type"] == P.GATE_TIMEOUT

        timeout_to_companion = json.loads(companion_ws.receive_text())
        assert timeout_to_companion == {"type": P.GATE_TIMEOUT, "gate_id": "g_timeout"}


def test_idle_timeout_suppressed_during_open_gate(monkeypatch: pytest.MonkeyPatch, client: TestClient):
    """C1: no CDP frames flow while a gate is open (by design), so the idle
    watcher must not reap the session on IDLE_TTL_S during that window —
    GATE_TTL_S governs it instead."""
    monkeypatch.setattr(config, "IDLE_TTL_S", 1)
    monkeypatch.setattr(config, "GATE_TTL_S", 7)

    with client.websocket_connect(f"/companion/{REGISTER_TOKEN}") as companion_ws:
        _register_companion(companion_ws, REGISTER_TOKEN)

        resp = client.post("/session/start", json={"owner": USER_ID}, headers=OP_HEADERS)
        session_token = resp.json()["session_token"]
        json.loads(companion_ws.receive_text())  # SESSION_START

        client.post(
            "/session/gate",
            json={
                "session_token": session_token,
                "gate_id": "g_idle",
                "kind": "login",
                "hint": "log in",
                "url_host": "example.com",
            },
            headers=OP_HEADERS,
        )
        json.loads(companion_ws.receive_text())  # GATE_OPEN

        time.sleep(6)
        assert server.registry.get_session(session_token) is not None

        timeout_to_companion = json.loads(companion_ws.receive_text())
        assert timeout_to_companion == {"type": P.GATE_TIMEOUT, "gate_id": "g_idle"}


def test_session_events_404_after_session_ends(client: TestClient):
    """/session/events is only addressable while the session is live."""
    with client.websocket_connect(f"/companion/{REGISTER_TOKEN}") as companion_ws:
        _register_companion(companion_ws, REGISTER_TOKEN)

        resp = client.post("/session/start", json={"owner": USER_ID}, headers=OP_HEADERS)
        session_token = resp.json()["session_token"]
        json.loads(companion_ws.receive_text())  # SESSION_START

        client.post("/session/stop", json={"session_token": session_token}, headers=OP_HEADERS)
        json.loads(companion_ws.receive_text())  # SESSION_ENDED to companion

        resp = client.get(f"/session/events/{session_token}")
        assert resp.status_code == 404


def test_heartbeat_miss_force_closes_companion(monkeypatch: pytest.MonkeyPatch, client: TestClient):
    """A companion that stops sending HEARTBEAT gets force-closed, tearing
    down its bound session with reason=companion_gone — the F1 failure mode."""
    monkeypatch.setattr(config, "HEARTBEAT_INTERVAL_S", 0.2)
    monkeypatch.setattr(config, "HEARTBEAT_MISS_LIMIT_S", 0.4)

    with client.websocket_connect(f"/companion/{REGISTER_TOKEN}") as companion_ws:
        _register_companion(companion_ws, REGISTER_TOKEN)

        resp = client.post("/session/start", json={"owner": USER_ID}, headers=OP_HEADERS)
        session = resp.json()
        json.loads(companion_ws.receive_text())  # SESSION_START

        with pytest.raises(Exception):
            companion_ws.receive_text()

    resp = client.get(f"/cdp/{session['session_token']}/json/version")
    assert resp.status_code == 404
    assert resp.json()["error"]["type"] == "UnknownSession"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
