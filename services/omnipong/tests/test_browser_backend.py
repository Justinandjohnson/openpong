"""Domain-service tests for the browser backend seam (browser_backend.py).

Proves the two promises the write path makes:

  1. With OMNIPONG_BROWSER=relay, `.credentials.json` is never read — the seam
     drives the user's own browser through the relay instead.
  2. With relay mode requested but no companion connected, the seam returns a
     clear TYPED error ("No companion connected — open OpenPong on your
     computer and pair it") instead of hanging or degrading.

These use a mocked relay transport (httpx.MockTransport) — no real relay, no
real browser. The live round trip is documented in docs/RELAY_ARCHITECTURE.md.
"""

from __future__ import annotations

import builtins
import json

import httpx
import pytest

import browser_backend
from browser_backend import (
    BrowserModeInvalid,
    NoCompanionConnected,
    RelayRefused,
    RelayUnreachable,
    StoredCredentialsDisabled,
    browser_mode,
    create_browser_manager,
    provision_relay_session,
    relay_config,
)

CREDENTIALS_BASENAME = ".credentials.json"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in (
        "OMNIPONG_BROWSER",
        "OMNIPONG_ALLOW_STORED_CREDENTIALS",
        "RELAY_URL",
        "RELAY_BASE_URL",
        "RELAY_TOKEN",
        "RELAY_OPERATOR_TOKEN",
        "RELAY_OWNER",
        "RELAY_PAIRING_TOKEN",
        "RELAY_REGISTER_TOKEN",
    ):
        monkeypatch.delenv(key, raising=False)
    yield


def _mock_relay(monkeypatch, handler):
    """Install an httpx.AsyncClient whose transport is a MockTransport."""
    real_client = httpx.AsyncClient

    def factory(**kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(**kwargs)

    monkeypatch.setattr(browser_backend.httpx, "AsyncClient", factory)


def _forbid_credentials_read(monkeypatch):
    """Make any attempt to open a `.credentials.json` file fail loudly."""
    real_open = builtins.open

    def guarded_open(file, *args, **kwargs):
        if isinstance(file, str) and file.endswith(CREDENTIALS_BASENAME):
            raise AssertionError(f"relay mode must not read {file}")
        return real_open(file, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", guarded_open)


# ---------------------------------------------------------------------------
# Mode selection
# ---------------------------------------------------------------------------


def test_default_mode_is_local_and_stored_credentials_are_off():
    assert browser_mode() == "local"
    assert browser_backend.allow_stored_credentials() is False


def test_invalid_mode_is_a_typed_error(monkeypatch):
    monkeypatch.setenv("OMNIPONG_BROWSER", "telepathy")
    with pytest.raises(BrowserModeInvalid):
        browser_mode()


def test_local_mode_without_optin_refuses_stored_credentials():
    """No `.credentials.json` read is even attempted without the explicit opt-in."""
    import browser_manager

    with pytest.raises(StoredCredentialsDisabled):
        browser_manager._get_cred("OMNIPONG_USER")


def test_create_browser_manager_selects_relay(monkeypatch):
    monkeypatch.setenv("OMNIPONG_BROWSER", "relay")
    monkeypatch.setenv("RELAY_URL", "https://relay.example")
    monkeypatch.setenv("RELAY_OWNER", "owner-1")
    manager = create_browser_manager()
    assert isinstance(manager, browser_backend.RelayBrowserManager)
    assert manager.relay.owner == "owner-1"


def test_create_browser_manager_selects_local(monkeypatch):
    manager = create_browser_manager()
    assert not isinstance(manager, browser_backend.RelayBrowserManager)


def test_relay_config_reads_primary_and_fallback_names(monkeypatch):
    monkeypatch.setenv("RELAY_URL", "https://relay.example/")
    monkeypatch.setenv("RELAY_OWNER", "owner-1")
    monkeypatch.setenv("RELAY_TOKEN", "tok")
    cfg = relay_config()
    assert cfg.url == "https://relay.example"
    assert cfg.owner == "owner-1"
    assert cfg.token == "tok"
    assert cfg.headers() == {"X-Operator-Token": "tok"}

    monkeypatch.delenv("RELAY_URL")
    monkeypatch.delenv("RELAY_TOKEN")
    monkeypatch.setenv("RELAY_BASE_URL", "https://old.example")
    monkeypatch.setenv("RELAY_OPERATOR_TOKEN", "old-tok")
    monkeypatch.setenv("RELAY_REGISTER_TOKEN", "rt_x")
    cfg2 = relay_config()
    assert cfg2.url == "https://old.example"
    assert cfg2.token == "old-tok"
    assert cfg2.pairing_token == "rt_x"


def test_relay_config_requires_a_url(monkeypatch):
    monkeypatch.setenv("RELAY_OWNER", "owner-1")
    with pytest.raises(RelayUnreachable):
        relay_config()


def test_relay_config_requires_owner_or_pairing_token(monkeypatch):
    monkeypatch.setenv("RELAY_URL", "https://relay.example")
    with pytest.raises(RelayRefused):
        relay_config()


# ---------------------------------------------------------------------------
# The typed "no companion" error
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_provision_maps_companion_not_online_to_no_companion(monkeypatch):
    monkeypatch.setenv("RELAY_URL", "https://relay.example")
    monkeypatch.setenv("RELAY_OWNER", "owner-1")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/session/start"
        return httpx.Response(
            404, json={"error": {"type": "CompanionNotOnline", "detail": "no companion"}}
        )

    _mock_relay(monkeypatch, handler)
    with pytest.raises(NoCompanionConnected) as excinfo:
        await provision_relay_session(relay_config())
    assert "No companion connected" in excinfo.value.detail
    assert "pair it" in excinfo.value.detail
    assert excinfo.value.code == "no_companion_connected"


@pytest.mark.asyncio
async def test_provision_maps_unknown_pairing_to_no_companion(monkeypatch):
    monkeypatch.setenv("RELAY_URL", "https://relay.example")
    monkeypatch.setenv("RELAY_OWNER", "owner-1")

    _mock_relay(
        monkeypatch,
        lambda request: httpx.Response(
            404, json={"error": {"type": "PairingNotFound", "detail": "no pairing"}}
        ),
    )
    with pytest.raises(NoCompanionConnected):
        await provision_relay_session(relay_config())


@pytest.mark.asyncio
async def test_provision_connection_failure_is_relay_unreachable(monkeypatch):
    monkeypatch.setenv("RELAY_URL", "https://relay.example")
    monkeypatch.setenv("RELAY_OWNER", "owner-1")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    _mock_relay(monkeypatch, handler)
    with pytest.raises(RelayUnreachable):
        await provision_relay_session(relay_config())


@pytest.mark.asyncio
async def test_provision_returns_session_token_on_success(monkeypatch):
    monkeypatch.setenv("RELAY_URL", "https://relay.example")
    monkeypatch.setenv("RELAY_OWNER", "owner-1")
    monkeypatch.setenv("RELAY_TOKEN", "tok")

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["headers"] = dict(request.headers)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"session_id": "s_1", "session_token": "st_1", "owner": "owner-1"})

    _mock_relay(monkeypatch, handler)
    session = await provision_relay_session(relay_config())
    assert session["session_token"] == "st_1"
    assert seen["path"] == "/session/start"
    assert seen["body"] == {"owner": "owner-1"}
    assert seen["headers"]["x-operator-token"] == "tok"


# ---------------------------------------------------------------------------
# Relay mode never touches .credentials.json
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_relay_manager_never_reads_credentials(monkeypatch):
    monkeypatch.setenv("OMNIPONG_BROWSER", "relay")
    monkeypatch.setenv("RELAY_URL", "https://relay.example")
    monkeypatch.setenv("RELAY_OWNER", "owner-1")
    _forbid_credentials_read(monkeypatch)

    _mock_relay(
        monkeypatch,
        lambda request: httpx.Response(
            404, json={"error": {"type": "CompanionNotOnline", "detail": "nope"}}
        ),
    )

    manager = create_browser_manager()
    # login_omnipong -> start() -> provision_relay_session; it fails before any
    # browser or credential work, with the typed error.
    with pytest.raises(NoCompanionConnected):
        await manager.login_omnipong()
    assert manager.session_token is None


@pytest.mark.asyncio
async def test_companion_status_reports_disconnected(monkeypatch):
    monkeypatch.setenv("RELAY_URL", "https://relay.example")
    monkeypatch.setenv("RELAY_OWNER", "owner-1")
    _mock_relay(
        monkeypatch,
        lambda request: httpx.Response(
            200,
            json={"owner": "owner-1", "paired": False, "connected": False, "gates": []},
        ),
    )
    status = await browser_backend.companion_status(relay_config())
    assert status["connected"] is False
    assert status["paired"] is False
