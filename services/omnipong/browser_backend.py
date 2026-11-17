"""Browser backend seam for the OmniPong domain service.

Two ways to drive a real browser for the *write* paths (tournament
registration and logged-in scraping):

  relay (recommended, no stored credentials)
      The user's own, already-logged-in Chrome is reached through the OpenPong
      relay + companion over CDP. The domain service never sees a password:
      it asks the relay for a per-owner session and connects Playwright to the
      relay's CDP facade. Selected with OMNIPONG_BROWSER=relay.

  local (legacy, opt-in only)
      The original Playwright profile + stored credentials. It is used ONLY
      when OMNIPONG_ALLOW_STORED_CREDENTIALS=true. Without that explicit
      opt-in, `browser_manager` never opens `.credentials.json`.

With OMNIPONG_BROWSER=relay, `.credentials.json` is not read at all.

Selection is one function (`create_browser_manager`); there is no fallback
chain — a misconfigured relay raises one clean typed error instead of hanging
or silently degrading to the stored-credential path.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

import httpx

BROWSER_MODE_LOCAL = "local"
BROWSER_MODE_RELAY = "relay"
VALID_BROWSER_MODES = frozenset({BROWSER_MODE_LOCAL, BROWSER_MODE_RELAY})

OMNIPONG_MEMBERS_URL = "https://www.omnipong.com/members.asp?m=21"


# ---------------------------------------------------------------------------
# Typed errors — each maps to exactly one clean failure (no retries/fallbacks).
# `code` is the stable, wire-facing type the API/agent surfaces.
# ---------------------------------------------------------------------------


class BrowserBackendError(Exception):
    code = "browser_backend_error"
    status_code = 500

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail

    def to_dict(self) -> dict:
        return {"error": {"type": self.code, "detail": self.detail}}


class BrowserModeInvalid(BrowserBackendError):
    code = "browser_mode_invalid"
    status_code = 500


class StoredCredentialsDisabled(BrowserBackendError):
    """The legacy stored-credential path was requested without an explicit
    opt-in. We refuse instead of silently reading `.credentials.json`."""

    code = "stored_credentials_disabled"
    status_code = 409


class NoCompanionConnected(BrowserBackendError):
    """Relay mode was requested but no companion is connected for this owner.

    The exact, user-facing failure the plan calls for: "No companion connected
    — open OpenPong on your computer and pair it." Returned instead of hanging.
    """

    code = "no_companion_connected"
    status_code = 503


class RelayUnreachable(BrowserBackendError):
    code = "relay_unreachable"
    status_code = 502


class RelayRefused(BrowserBackendError):
    code = "relay_refused"
    status_code = 502


class NotLoggedIn(BrowserBackendError):
    """The user is not logged in to OmniPong in their own browser. Nothing was
    scraped and no credential was entered — the human logs in themselves."""

    code = "not_logged_in"
    status_code = 409


NO_COMPANION_MESSAGE = (
    "No companion connected — open OpenPong on your computer and pair it "
    "(Settings → Your computer), then try again."
)


# ---------------------------------------------------------------------------
# Configuration (read from env; documented in .env.example)
# ---------------------------------------------------------------------------


def browser_mode() -> str:
    mode = (os.getenv("OMNIPONG_BROWSER") or BROWSER_MODE_LOCAL).strip().lower()
    if mode not in VALID_BROWSER_MODES:
        raise BrowserModeInvalid(
            f"OMNIPONG_BROWSER must be one of {sorted(VALID_BROWSER_MODES)}, got {mode!r}"
        )
    return mode


def allow_stored_credentials() -> bool:
    return (os.getenv("OMNIPONG_ALLOW_STORED_CREDENTIALS") or "").strip().lower() == "true"


@dataclass(frozen=True)
class RelayConfig:
    url: str
    owner: Optional[str] = None
    token: Optional[str] = None
    pairing_token: Optional[str] = None

    def headers(self) -> dict:
        return {"X-Operator-Token": self.token} if self.token else {}


def relay_config() -> RelayConfig:
    """Read the relay settings from the environment.

    Primary names are RELAY_URL / RELAY_TOKEN / RELAY_OWNER /
    RELAY_PAIRING_TOKEN. The upstream names RELAY_BASE_URL /
    RELAY_OPERATOR_TOKEN / RELAY_REGISTER_TOKEN are accepted as fallbacks so an
    existing deployment keeps working.
    """
    url = (os.getenv("RELAY_URL") or os.getenv("RELAY_BASE_URL") or "").strip()
    owner = (os.getenv("RELAY_OWNER") or "").strip() or None
    pairing_token = (
        (os.getenv("RELAY_PAIRING_TOKEN") or os.getenv("RELAY_REGISTER_TOKEN") or "").strip() or None
    )
    token = (os.getenv("RELAY_TOKEN") or os.getenv("RELAY_OPERATOR_TOKEN") or "").strip() or None
    if not url:
        raise RelayUnreachable(
            "OMNIPONG_BROWSER=relay requires RELAY_URL (e.g. https://relay.example)"
        )
    if not owner and not pairing_token:
        raise RelayRefused(
            "OMNIPONG_BROWSER=relay requires RELAY_OWNER (the account/owner this "
            "domain service drives) or RELAY_PAIRING_TOKEN, so the relay can "
            "enforce per-user pairing."
        )
    return RelayConfig(url=url.rstrip("/"), owner=owner, token=token, pairing_token=pairing_token)


# ---------------------------------------------------------------------------
# Relay control calls (operator-authenticated)
# ---------------------------------------------------------------------------


def _relay_http_error(exc: Exception) -> RelayUnreachable:
    return RelayUnreachable(f"Could not reach the relay at the configured RELAY_URL: {exc}")


def _error_type(resp: httpx.Response) -> str | None:
    try:
        data = resp.json()
    except ValueError:
        return None
    if isinstance(data, dict) and isinstance(data.get("error"), dict):
        return data["error"].get("type")
    return None


async def companion_status(relay: RelayConfig) -> dict:
    """GET /companions/{owner}: paired / connected / pending gates.

    A relay that has no pairing for this owner answers 200 with
    paired=false/connected=false; that is a status, not an error.
    """
    if not relay.owner:
        # Without an owner we can still report "unknown"; the caller (the
        # status tool) always has one. Refuse rather than guess.
        raise RelayRefused("companion_status needs RELAY_OWNER")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{relay.url}/companions/{relay.owner}", headers=relay.headers()
            )
    except httpx.HTTPError as exc:
        raise _relay_http_error(exc) from exc
    if resp.status_code != 200:
        raise RelayRefused(f"Relay refused the companion status read: {_detail(resp)}")
    return resp.json()


async def provision_relay_session(relay: RelayConfig) -> dict:
    """POST /session/start for this owner.

    The relay itself refuses when no companion is online (404
    CompanionNotOnline) or no pairing exists (404 PairingNotFound); both map to
    one clear NoCompanionConnected so a caller never hangs on a browser that
    will never answer.
    """
    body: dict = {}
    if relay.owner:
        body["owner"] = relay.owner
    if relay.pairing_token:
        body["pairing_token"] = relay.pairing_token
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{relay.url}/session/start", json=body, headers=relay.headers()
            )
    except httpx.HTTPError as exc:
        raise _relay_http_error(exc) from exc
    if resp.status_code != 200:
        error_type = _error_type(resp)
        if resp.status_code == 404 and error_type in ("CompanionNotOnline", "PairingNotFound"):
            raise NoCompanionConnected(NO_COMPANION_MESSAGE)
        if resp.status_code == 403 and error_type == "OwnerMismatch":
            raise RelayRefused(f"Relay refused the session (owner mismatch): {_detail(resp)}")
        raise RelayRefused(f"Relay refused to start a session: {_detail(resp)}")
    session_token = resp.json().get("session_token")
    if not session_token:
        raise RelayRefused("Relay /session/start response missing session_token")
    return resp.json()


async def stop_relay_session(relay: RelayConfig, session_token: str) -> None:
    """Best-effort POST /session/stop so a re-run is not blocked by a 409."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.post(
                f"{relay.url}/session/stop",
                json={"session_token": session_token},
                headers=relay.headers(),
            )
    except httpx.HTTPError:
        # The relay reaps idle sessions on its own; a failure here is not fatal.
        pass


def relay_cdp_url(relay: RelayConfig, session_token: str) -> str:
    return f"{relay.url}/cdp/{session_token}"


def _detail(resp: httpx.Response) -> str:
    try:
        data = resp.json()
    except ValueError:
        return resp.text[:300]
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict) and error.get("detail"):
            return str(error["detail"])
        for key in ("detail", "message"):
            if isinstance(data.get(key), str):
                return data[key]
    return str(data)[:300]


# ---------------------------------------------------------------------------
# Browser managers
# ---------------------------------------------------------------------------


class RelayBrowserManager:
    """A drop-in stand-in for `BrowserManager` that drives the user's own
    browser through the relay instead of a local Playwright profile.

    It exposes the same surface `OmniPongScraper` uses (`context`, `start`,
    `get_page`, `login_omnipong`, `stop`), so the existing page-interaction
    code runs unchanged — the only difference is *whose* browser it drives and
    that no credential is ever read.
    """

    def __init__(self, relay: RelayConfig | None = None):
        self.relay = relay or relay_config()
        self.browser = None
        self.context = None
        self.pw = None
        self.session_token: Optional[str] = None

    async def start(self, headless: bool = True):  # headless is ignored: it is the user's real browser
        from playwright.async_api import async_playwright

        session = await provision_relay_session(self.relay)
        self.session_token = session["session_token"]
        self.pw = await async_playwright().start()
        self.browser = await self.pw.chromium.connect_over_cdp(
            relay_cdp_url(self.relay, self.session_token)
        )
        contexts = self.browser.contexts
        # The user already has a browser context (their real profile); reuse it
        # so their existing login is what the scraper sees.
        self.context = contexts[0] if contexts else await self.browser.new_context()
        return self.context

    async def get_page(self):
        if not self.context:
            await self.start()
        return self.context.pages[0] if self.context.pages else await self.context.new_page()

    async def login_omnipong(self):
        """In relay mode the user is already logged in in their own Chrome.

        We navigate to the member page and check for the Log Out link; if it is
        missing, we raise a clean NotLoggedIn (the human logs in themselves —
        no credential is ever entered by the service).
        """
        page = await self.get_page()
        await page.goto(OMNIPONG_MEMBERS_URL)
        if await page.query_selector('a[title="Log Out"]'):
            return True
        raise NotLoggedIn(
            "You are not logged in to OmniPong in the browser the companion is "
            "driving. Open OmniPong there, log in yourself, then try again."
        )

    async def stop(self):
        try:
            if self.context:
                try:
                    await self.context.close()
                except Exception:  # noqa: BLE001 - CDP may already be gone
                    pass
            if self.browser:
                try:
                    await self.browser.close()
                except Exception:  # noqa: BLE001 - CDP may already be gone
                    pass
            if self.pw:
                await self.pw.stop()
            if self.session_token:
                await stop_relay_session(self.relay, self.session_token)
                self.session_token = None
        finally:
            self.context = None
            self.browser = None
            self.pw = None


def create_browser_manager():
    """Return the browser manager selected by OMNIPONG_BROWSER.

    - relay: RelayBrowserManager. It pre-checks that a companion is connected
      and raises NoCompanionConnected (a clear typed error) rather than
      launching a browser that will never answer.
    - local: the original BrowserManager. Its credential reads are gated by
      OMNIPONG_ALLOW_STORED_CREDENTIALS inside browser_manager itself.
    """
    mode = browser_mode()
    if mode == BROWSER_MODE_RELAY:
        return RelayBrowserManager(relay_config())
    from browser_manager import BrowserManager

    return BrowserManager()
