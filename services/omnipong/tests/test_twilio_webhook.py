"""The inbound SMS webhook: signature gate and rule-based replies.

No Twilio account, no network — only the signature maths we already own.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _sign(token: str, url: str, params: dict[str, str]) -> str:
    payload = url + "".join(key + params[key] for key in sorted(params))
    digest = hmac.new(token.encode(), payload.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("OMNIPONG_DB", str(tmp_path / "webhook.db"))
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", "test-auth-token")
    monkeypatch.delenv("TWILIO_PUBLIC_HOST", raising=False)
    main = importlib.import_module("backend.main")
    app = FastAPI()
    app.post("/webhooks/twilio")(main.twilio_webhook)
    return TestClient(app)


def test_unsigned_request_is_rejected(client):
    response = client.post("/webhooks/twilio", data={"Body": "help", "From": "+15125550001"})
    assert response.status_code == 403
    assert "signature" in response.json()["error"].lower()


def test_wrong_signature_is_rejected(client):
    params = {"Body": "help", "From": "+15125550001"}
    response = client.post(
        "/webhooks/twilio",
        data=params,
        headers={"X-Twilio-Signature": _sign("wrong-token", "http://testserver/webhooks/twilio", params)},
    )
    assert response.status_code == 403


def test_help_lists_the_commands(client):
    params = {"Body": "help", "From": "+15125550001", "MessageSid": "SM1"}
    response = client.post(
        "/webhooks/twilio",
        data=params,
        headers={"X-Twilio-Signature": _sign("test-auth-token", "http://testserver/webhooks/twilio", params)},
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/xml")
    assert "MATCHES" in response.text and "RATING" in response.text


def test_matches_with_an_empty_ledger_is_still_a_200(client):
    params = {"Body": "my matches", "From": "+15125550001"}
    response = client.post(
        "/webhooks/twilio",
        data=params,
        headers={"X-Twilio-Signature": _sign("test-auth-token", "http://testserver/webhooks/twilio", params)},
    )
    assert response.status_code == 200
    assert "match" in response.text.lower()


def test_sync_points_at_the_dashboard(client):
    params = {"Body": "sync", "From": "+15125550001"}
    response = client.post(
        "/webhooks/twilio",
        data=params,
        headers={"X-Twilio-Signature": _sign("test-auth-token", "http://testserver/webhooks/twilio", params)},
    )
    assert response.status_code == 200
    assert "dashboard" in response.text.lower()