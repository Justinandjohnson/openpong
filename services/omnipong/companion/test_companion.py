"""Companion integration test against a FAKE CDP endpoint and a fake relay.

Proves the companion's real protocol behaviour end to end without a real
browser, a real relay process, or a real login:

  - register with the pairing token,
  - proxy a CDP discovery GET and return the RAW body (unrewritten),
  - open a devtools websocket channel and round-trip a CDP frame,
  - show a gate prompt and complete the handshake two ways: the user clicks
    Continue in the local prompt, and the relay clears the gate itself
    (the dashboard's "I handled it, continue").

The fake Chrome is an aiohttp app on 127.0.0.1 that echoes devtools frames —
it is clearly a stand-in, not a real Chrome. What this does NOT prove (a real
Chrome with --remote-debugging-port=9222) is listed in the build report.
"""

from __future__ import annotations

import asyncio
import json
import re
import socket

import pytest

pytestmark = pytest.mark.asyncio

FAKE_BROWSER_ID = "fake-browser-id"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def _start(app, port: int):
    from aiohttp import web

    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    return runner


# ---------------------------------------------------------------------------
# Fake Chrome (the thing the companion proxies to)
# ---------------------------------------------------------------------------


def build_mock_chrome_app(chrome_port: int):
    from aiohttp import WSMsgType, web

    ws_debugger_url = f"ws://127.0.0.1:{chrome_port}/devtools/browser/{FAKE_BROWSER_ID}"

    async def json_version(_request):
        return web.json_response(
            {"Browser": "Chrome/999.0 (mock)", "webSocketDebuggerUrl": ws_debugger_url}
        )

    async def devtools_ws(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                await ws.send_str(msg.data)  # echo — proves frames flow both ways
            elif msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                break
        return ws

    app = web.Application()
    app.router.add_get("/json/version", json_version)
    app.router.add_get(f"/devtools/browser/{FAKE_BROWSER_ID}", devtools_ws)
    return app


# ---------------------------------------------------------------------------
# Fake relay: drives the whole sequence as the "server side"
# ---------------------------------------------------------------------------


class CheckFailed(AssertionError):
    pass


async def _recv_json(ws, expect_type: str) -> dict:
    from aiohttp import WSMsgType

    msg = await asyncio.wait_for(ws.receive(), timeout=5)
    if msg.type != WSMsgType.TEXT:
        raise CheckFailed(f"expected TEXT ws message, got {msg.type}")
    data = json.loads(msg.data)
    if data.get("type") != expect_type:
        raise CheckFailed(f"expected {expect_type!r}, got {data.get('type')!r}: {data}")
    return data


def build_mock_relay_app(results: dict, chrome_port: int, gate_ui_port: int, mode: str):
    from aiohttp import ClientSession, ClientTimeout, web

    async def companion_ws(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        try:
            reg = await _recv_json(ws, "REGISTER")
            assert reg["register_token"] == "pair_test_token", reg
            assert reg["chrome_debug_port"] == chrome_port, reg
            results["register"] = True
            await ws.send_str(
                json.dumps(
                    {
                        "type": "REGISTER_OK",
                        "user_id": "u_selftest",
                        "owner": "u_selftest",
                        "heartbeat_interval_s": 30,
                    }
                )
            )

            # CDP HTTP proxy — companion returns the RAW body, unrewritten.
            await ws.send_str(
                json.dumps({"type": "CDP_HTTP_REQ", "req_id": "h1", "path": "/json/version"})
            )
            res = await _recv_json(ws, "CDP_HTTP_RES")
            assert res["req_id"] == "h1", res
            assert res["status"] == 200, res
            assert res["body"]["webSocketDebuggerUrl"].endswith(f"/devtools/browser/{FAKE_BROWSER_ID}")
            results["cdp_http_proxy"] = True

            # Devtools channel round trip.
            await ws.send_str(
                json.dumps(
                    {
                        "type": "CDP_WS_OPEN",
                        "channel": 1,
                        "target_ws_path": f"/devtools/browser/{FAKE_BROWSER_ID}",
                    }
                )
            )
            opened = await _recv_json(ws, "CDP_WS_OPEN_OK")
            assert opened["channel"] == 1, opened
            frame_out = {"id": 7, "method": "Test.echo", "params": {"ping": "pong"}}
            await ws.send_str(json.dumps({"type": "CDP_WS_FRAME", "channel": 1, "data": frame_out}))
            frame_in = await _recv_json(ws, "CDP_WS_FRAME")
            assert frame_in["data"] == frame_out, frame_in
            results["cdp_ws_proxy"] = True
            await ws.send_str(json.dumps({"type": "CDP_WS_CLOSE", "channel": 1, "code": 1000}))

            # Gate handshake.
            gate_id = "g_selftest"
            await ws.send_str(
                json.dumps(
                    {
                        "type": "GATE_OPEN",
                        "gate_id": gate_id,
                        "kind": "login",
                        "hint": "Log in on the mock site, then continue.",
                        "url_host": "example.com",
                    }
                )
            )
            gate_url = f"http://127.0.0.1:{gate_ui_port}/"
            if mode == "user_clicks":
                async with ClientSession(timeout=ClientTimeout(total=1)) as client:
                    page_html = None
                    for _ in range(20):
                        try:
                            async with client.get(gate_url) as resp:
                                if resp.status == 200:
                                    page_html = await resp.text()
                                    break
                        except Exception:
                            await asyncio.sleep(0.25)
                    if page_html is None:
                        raise CheckFailed("companion's gate UI never came up on GATE_OPEN")
                    nonce_match = re.search(r"X-Gate-Nonce':'([^']+)'", page_html)
                    if not nonce_match:
                        raise CheckFailed("gate UI page did not embed an X-Gate-Nonce")
                    async with client.post(
                        gate_url + "continue", headers={"X-Gate-Nonce": nonce_match.group(1)}
                    ) as resp:
                        assert resp.status == 200, f"gate /continue returned {resp.status}"
            else:
                # The relay clears the gate itself (dashboard Continue).
                await asyncio.sleep(0.5)
                await ws.send_str(json.dumps({"type": "GATE_CLEARED", "gate_id": gate_id}))

            cleared = await _recv_json(ws, "GATE_CLEARED")
            assert cleared["gate_id"] == gate_id, cleared
            results["gate_roundtrip"] = True

            await ws.send_str(
                json.dumps({"type": "SESSION_ENDED", "session_id": "s_selftest", "reason": "completed"})
            )
            await asyncio.sleep(0.3)
        except CheckFailed as exc:
            results["error"] = str(exc)
        except Exception as exc:  # noqa: BLE001
            results["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            await ws.close()
        return ws

    app = web.Application()
    app["results"] = results
    app.router.add_get("/companion/{token}", companion_ws)
    return app


async def _run_selftest(mode: str) -> dict:
    import companion_protocol as proto
    from companion import Companion

    results: dict = {}
    relay_port = _free_port()
    chrome_port = _free_port()
    gate_ui_port = _free_port()

    relay_runner = await _start(
        build_mock_relay_app(results, chrome_port, gate_ui_port, mode), relay_port
    )
    chrome_runner = await _start(build_mock_chrome_app(chrome_port), chrome_port)

    companion = Companion(
        relay_base_url=f"ws://127.0.0.1:{relay_port}",
        pairing_token="pair_test_token",
        chrome_port=chrome_port,
        gate_ui_port=gate_ui_port,
        launch_chrome_on_start=False,  # the mock Chrome stands in for the real thing
    )
    try:
        await asyncio.wait_for(companion.run(), timeout=20)
    except TimeoutError:
        results.setdefault("error", "companion.run() did not complete within 20s")
    finally:
        await relay_runner.cleanup()
        await chrome_runner.cleanup()

    assert "error" not in results, results["error"]
    for check in ("register", "cdp_http_proxy", "cdp_ws_proxy", "gate_roundtrip"):
        assert results.get(check), f"{check} did not complete: {results}"
    return results


async def test_companion_full_round_trip_when_user_clicks_continue():
    await _run_selftest("user_clicks")


async def test_companion_gate_cleared_by_relay_dashboard_action():
    await _run_selftest("relay_clears")
