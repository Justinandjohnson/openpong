"""Minimal local gate prompt (§3.2 / §3 of docs/RELAY_ARCHITECTURE.md).

On GATE_OPEN the companion must show the user a clear local prompt telling them
to solve something (login / Cloudflare / captcha / 2FA) in their own Chrome tab,
then click Continue. One method: a tiny stdlib HTTP page on 127.0.0.1 — no GUI
toolkit dependency, works identically on Windows and macOS.
"""
from __future__ import annotations

import asyncio
import html
import json
import secrets
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _render_page(kind: str, hint: str, url_host: str, nonce: str) -> bytes:
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>OpenPong — action needed</title>
<style>
  body {{ font-family: -apple-system, Segoe UI, sans-serif; max-width: 480px;
          margin: 10vh auto; text-align: center; color: #222; }}
  .badge {{ display: inline-block; background: #fee; color: #900; padding: 4px 10px;
            border-radius: 999px; font-size: 12px; font-weight: 600; letter-spacing: .04em; }}
  button {{ margin-top: 24px; font-size: 16px; padding: 12px 28px; border-radius: 8px;
            border: none; background: #111; color: #fff; cursor: pointer; }}
  button:hover {{ background: #333; }}
  button:disabled {{ background: #999; cursor: default; }}
  code {{ background: #f2f2f2; padding: 2px 6px; border-radius: 4px; }}
  #msg {{ margin-top: 18px; font-size: 13px; color: #900; min-height: 1.2em; }}
</style></head>
<body>
  <div class="badge">AGENT ACTIVE — {html.escape(kind.upper())}</div>
  <h2>An AI agent is driving your browser</h2>
  <p>{html.escape(hint)}</p>
  <p>Site: <code>{html.escape(url_host)}</code></p>
  <p>Switch to your Chrome window, finish it there, then come back and click Continue.</p>
  <button id="go" type="button">Continue</button>
  <p id="msg"></p>
  <script>
    var NONCE = {json.dumps(nonce)};
    var done = false;
    var button = document.getElementById('go');
    var message = document.getElementById('msg');

    // The companion serves this page. If it stops (crash, Ctrl-C, lost tunnel)
    // the button silently does nothing, so say so instead of pretending.
    async function alive() {{
      try {{ var r = await fetch('/ping', {{cache: 'no-store'}}); return r.ok; }}
      catch (e) {{ return false; }}
    }}
    async function checkAlive() {{
      if (done) return;
      if (!(await alive())) {{
        button.disabled = true;
        message.textContent = 'The OpenPong companion has stopped, so this prompt is no longer connected. Start it again from OpenPong and retry.';
      }}
    }}
    setInterval(checkAlive, 3000);
    checkAlive();

    button.addEventListener('click', async function () {{
      button.disabled = true;
      button.textContent = 'Working…';
      try {{
        var r = await fetch('/continue', {{method: 'POST', headers: {{'X-Gate-Nonce': NONCE}}}});
        if (!r.ok) throw new Error('HTTP ' + r.status);
        done = true;
        document.body.innerHTML = '<h2>Thanks — resuming…</h2><p>You can close this tab.</p>';
      }} catch (e) {{
        button.disabled = false;
        button.textContent = 'Continue';
        message.textContent = 'Could not reach the companion (' + e.message + '). Nothing was resumed — start it again from OpenPong, then retry.';
      }}
    }});
  </script>
</body></html>""".encode()


class _GateServer(ThreadingHTTPServer):
    allow_reuse_address = True


class GateUI:
    """One gate prompt at a time, per the relay's one-session-per-companion model."""

    def __init__(self, host: str = "127.0.0.1", port: int = 8766):
        self._host = host
        self._port = port
        self._server: _GateServer | None = None
        self._thread: threading.Thread | None = None

    def open(self, gate_id: str, kind: str, hint: str, url_host: str, on_continue) -> None:
        """Show the prompt. `on_continue` is called (no args) from the server thread
        when the user clicks Continue — the caller is responsible for thread-safe
        hand-off (e.g. loop.call_soon_threadsafe) back into asyncio.

        S4: /continue requires a per-gate random nonce, generated here and
        embedded only in the page the user actually clicks — any other page's
        JS hitting /continue blind (CSRF) doesn't know it and is rejected.
        """
        nonce = secrets.token_urlsafe(24)
        page = _render_page(kind, hint, url_host, nonce)
        continued = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass  # keep stdout clean

            def do_GET(self):
                # The page polls this so it can tell the user when the companion
                # has gone away, instead of a button that silently does nothing.
                if self.path.split("?")[0] == "/ping":
                    body = b'{"ok":true}'
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(page)

            def do_POST(self):
                if self.path != "/continue" or continued.is_set():
                    self.send_response(404)
                    self.end_headers()
                    return
                # Compare against the port we actually bound (the requested one
                # may have been taken, in which case we fell back to an
                # ephemeral port) — otherwise the real page would be refused.
                bound_host, bound_port = self.server.server_address[0], self.server.server_address[1]
                expected_origin = f"http://{bound_host}:{bound_port}"
                origin = self.headers.get("Origin") or self.headers.get("Referer") or ""
                if origin and not origin.startswith(expected_origin):
                    self.send_response(403)
                    self.end_headers()
                    return
                if self.headers.get("X-Gate-Nonce") != nonce:
                    self.send_response(403)
                    self.end_headers()
                    return
                continued.set()
                self.send_response(200)
                self.end_headers()
                on_continue()

        try:
            self._server = _GateServer((self._host, self._port), Handler)
        except OSError:
            # The preferred port is taken (e.g. the relay is on 8765 too). Bind
            # an ephemeral port instead of failing — a prompt the user never
            # sees is worse than a URL they have to look at.
            self._server = _GateServer((self._host, 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        bound_port = self._server.server_address[1]
        url = f"http://{self._host}:{bound_port}/"
        print(f"[companion] GATE OPEN ({kind}): {hint} — opening {url}")
        webbrowser.open(url)

    def close(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=2)
            self._thread = None

    async def wait_for_continue(self, gate_id: str, kind: str, hint: str, url_host: str) -> None:
        """Async convenience wrapper: opens the prompt and awaits the Continue click."""
        loop = asyncio.get_running_loop()
        future: asyncio.Future[None] = loop.create_future()

        def _on_continue():
            loop.call_soon_threadsafe(lambda: future.done() or future.set_result(None))

        self.open(gate_id, kind, hint, url_host, _on_continue)
        try:
            await future
        finally:
            self.close()
