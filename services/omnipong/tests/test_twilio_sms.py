"""Twilio signature and SMS formatting tests — no network, no real Twilio."""

from __future__ import annotations

import base64
import hashlib
import hmac
from urllib.parse import urlencode

import pytest

from backend import twilio_sms


def _sign(token: str, url: str, params: dict[str, str]) -> str:
    payload = url + "".join(key + params[key] for key in sorted(params))
    digest = hmac.new(token.encode(), payload.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def test_verify_accepts_a_correctly_signed_request():
    token = "test-auth-token"
    url = "https://openpong.example.com/webhooks/twilio"
    params = {"From": "+15125550001", "Body": "rating", "MessageSid": "SM123"}
    signature = _sign(token, url, params)
    assert twilio_sms.verify_signature(signature, url, params, token) is True


def test_verify_rejects_tampering_and_missing_signature():
    token = "test-auth-token"
    url = "https://openpong.example.com/webhooks/twilio"
    params = {"From": "+15125550001", "Body": "rating"}
    signature = _sign(token, url, params)
    assert twilio_sms.verify_signature(signature, url, {"From": "+15125550001", "Body": "matches"}, token) is False
    assert twilio_sms.verify_signature(None, url, params, token) is False
    assert twilio_sms.verify_signature(signature, url, params, "") is False


def test_verify_fails_closed_without_a_configured_token(monkeypatch):
    monkeypatch.delenv("TWILIO_AUTH_TOKEN", raising=False)
    url = "https://openpong.example.com/webhooks/twilio"
    params = {"Body": "help"}
    assert twilio_sms.verify_signature(_sign("anything", url, params), url, params) is False


def test_public_url_prefers_the_configured_public_origin(monkeypatch):
    monkeypatch.setenv("TWILIO_PUBLIC_HOST", "openpong.example.com")
    monkeypatch.delenv("TWILIO_PUBLIC_SCHEME", raising=False)
    assert (
        twilio_sms.public_url_for("http://127.0.0.1:8000/webhooks/twilio")
        == "https://openpong.example.com/webhooks/twilio"
    )
    monkeypatch.delenv("TWILIO_PUBLIC_HOST")
    assert (
        twilio_sms.public_url_for("https://openpong.example.com/webhooks/twilio")
        == "https://openpong.example.com/webhooks/twilio"
    )


def test_numbers_normalize_to_e164():
    assert twilio_sms.normalize_number("512-555-0001") == "+15125550001"
    assert twilio_sms.normalize_number("15125550001") == "+15125550001"
    assert twilio_sms.normalize_number("+44 20 7946 0000") == "+442079460000"
    assert twilio_sms.normalize_number("") == ""


def test_sms_is_unavailable_without_configuration(monkeypatch):
    for key in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"):
        monkeypatch.delenv(key, raising=False)
    assert twilio_sms.sms_configured() is False
    sent, detail = twilio_sms.send_sms("+15125550001", "hello")
    assert sent is False
    assert "not configured" in detail


def test_commands_are_rule_based():
    assert twilio_sms.command_from_body("my matches") == "matches"
    assert twilio_sms.command_from_body("what tournaments are near me") == "tournaments"
    assert twilio_sms.command_from_body("rating?") == "rating"
    assert twilio_sms.command_from_body("refresh") == "sync"
    assert twilio_sms.command_from_body("hello") == "help"
    assert twilio_sms.command_from_body("") == "help"


def test_match_formatting_is_short_and_readable():
    result = {
        "matches": [
            {"date": "2025-12-03T00:00:00", "opponent_name": "Chen, Han", "result": "Loss", "score_summary": "0-3", "opponent_rating": 1238},
            {"date": "2025-12-29", "opponent_name": "Steve", "result": "Win", "score_summary": "3-0", "opponent_rating": 1200},
            {"date": "2025-11-20", "opponent_name": "Ana", "result": "Win", "score_summary": "3-2", "opponent_rating": 1100},
            {"date": "2025-11-10", "opponent_name": "Bo", "result": "Win", "score_summary": "3-1", "opponent_rating": 1150},
        ]
    }
    text = twilio_sms.format_matches(result, limit=3)
    assert "Chen, Han" in text
    assert "+1 more in OpenPong" in text
    assert len(text) < 320


def test_empty_results_read_as_data_not_failure():
    assert "No matches" in twilio_sms.format_matches({"matches": []})
    assert "No upcoming tournaments" in twilio_sms.format_tournaments({"tournaments": []})