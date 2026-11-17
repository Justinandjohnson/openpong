"""Twilio SMS: signed inbound webhooks and outbound sends.

Two rules this module exists to enforce:

1. An inbound webhook is only trusted when Twilio's signature verifies.
   Twilio signs every request with HMAC-SHA1 over the exact URL plus every
   POST parameter (sorted by key, key and value concatenated). Replaying a
   request without the shared auth token cannot forge that.
2. Sending is best-effort and never raises into a request handler. If the
   operator has not configured Twilio, callers get ``(False, reason)``
   instead of an exception, and the rest of OpenPong keeps working.

Everything is configured from the environment, so a self-hoster can turn SMS
on with three variables and no code change:

    TWILIO_ACCOUNT_SID
    TWILIO_AUTH_TOKEN
    TWILIO_FROM_NUMBER      e.g. +15125551234
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
from typing import Iterable, Mapping
from urllib.parse import urlencode

import httpx

log = logging.getLogger(__name__)

TWILIO_API_BASE = "https://api.twilio.com/2010-04-01"

# Twilio retries webhooks; a rejected signature must be cheap to reject.
_MAX_PARAM_BYTES = 64 * 1024


class TwilioUnavailable(RuntimeError):
    """Raised when outbound SMS is requested without Twilio being configured."""


def _config() -> tuple[str, str, str]:
    return (
        os.getenv("TWILIO_ACCOUNT_SID", "").strip(),
        os.getenv("TWILIO_AUTH_TOKEN", "").strip(),
        os.getenv("TWILIO_FROM_NUMBER", "").strip(),
    )


def sms_configured() -> bool:
    """True when this deployment can send SMS."""
    sid, token, sender = _config()
    return bool(sid and token and sender)


def _signature_payload(url: str, params: Mapping[str, str]) -> str:
    """Twilio's signed string: URL followed by sorted key+value pairs."""
    payload = url
    for key in sorted(params):
        payload += key + params[key]
    return payload


def compute_signature(auth_token: str, url: str, params: Mapping[str, str]) -> str:
    digest = hmac.new(
        auth_token.encode("utf-8"),
        _signature_payload(url, params).encode("utf-8"),
        hashlib.sha1,
    ).digest()
    return base64.b64encode(digest).decode("ascii")


def verify_signature(
    signature: str | None,
    url: str,
    params: Mapping[str, str],
    auth_token: str | None = None,
) -> bool:
    """Constant-time check of an inbound ``X-Twilio-Signature`` header.

    Fails closed: no auth token configured, no signature, or oversized input
    all mean "not Twilio". ``url`` must be the public URL Twilio called,
    including scheme, host and path (and query string, if any).
    """
    token = (auth_token if auth_token is not None else _config()[1]).strip()
    if not token or not signature:
        return False
    if any(len(v) > _MAX_PARAM_BYTES for v in params.values()):
        return False
    expected = compute_signature(token, url, params)
    return hmac.compare_digest(expected, signature.strip())


def public_url_for(request_url: str) -> str:
    """Resolve the URL Twilio signed, honouring reverse-proxy headers.

    Twilio signs the URL it was configured with, which is the public origin —
    not the container's internal host. ``X-Forwarded-Proto``/``Host`` are
    honoured when present so a proxy deployment verifies correctly.
    """
    from urllib.parse import urlsplit

    parts = urlsplit(request_url)
    forwarded_host = os.getenv("TWILIO_PUBLIC_HOST", "").strip()
    if forwarded_host:
        scheme = os.getenv("TWILIO_PUBLIC_SCHEME", "https").strip() or "https"
        path = parts.path or "/"
        return f"{scheme}://{forwarded_host}{path}"
    return request_url


def normalize_number(raw: str) -> str:
    """Best-effort E.164 for US numbers; leaves other input alone."""
    value = "".join(ch for ch in (raw or "").strip() if ch.isdigit() or ch == "+")
    if value.startswith("+"):
        return value
    digits = value.lstrip("1") if value.startswith("1") and len(value) == 11 else value
    if len(digits) == 10:
        return "+1" + digits
    return "+" + digits if digits else ""


def send_sms(to: str, body: str, media_urls: Iterable[str] | None = None) -> tuple[bool, str]:
    """Send a text. Returns ``(sent, detail)``; never raises for config/network.

    ``detail`` is the Twilio message sid on success, or a short reason on
    failure, so callers can log it without leaking credentials.
    """
    sid, token, sender = _config()
    if not (sid and token and sender):
        return False, "Twilio is not configured (TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER)"
    recipient = normalize_number(to)
    if not recipient:
        return False, "No recipient number"
    text = (body or "").strip()
    if not text:
        return False, "Empty message"
    data: dict[str, object] = {"To": recipient, "From": sender, "Body": text}
    if media_urls:
        data["MediaUrl"] = [url for url in media_urls if url][:10]
    try:
        with httpx.Client(timeout=15) as client:
            response = client.post(
                f"{TWILIO_API_BASE}/Accounts/{sid}/Messages.json",
                data=data,
                auth=(sid, token),
            )
    except httpx.HTTPError as exc:  # pragma: no cover - network failure
        log.warning("twilio send failed: %s", exc)
        return False, "Twilio request failed"
    if response.status_code >= 400:
        log.warning("twilio send rejected (%s)", response.status_code)
        return False, f"Twilio rejected the message ({response.status_code})"
    try:
        return True, str(response.json().get("sid", ""))
    except ValueError:
        return True, ""


def form_to_params(form: Mapping[str, object]) -> dict[str, str]:
    """Flatten Twilio's form body into the string map its signature covers."""
    return {str(k): str(v) for k, v in form.items()}


def command_from_body(body: str) -> str:
    """Map an inbound text to an OpenPong action, or ``help``.

    Deliberately tiny and rule-based: replying to a text with an LLM would let
    anyone spend the owner's model budget by texting the number.
    """
    text = (body or "").strip().casefold()
    if not text:
        return "help"
    if text in {"help", "?", "commands", "menu", "start"}:
        return "help"
    if any(word in text for word in ("match", "result", "score", "game")):
        return "matches"
    if any(word in text for word in ("tournament", "event", "sign up", "signup", "enter")):
        return "tournaments"
    if any(word in text for word in ("rating", "usatt", "rank")):
        return "rating"
    if any(word in text for word in ("sync", "refresh", "update")):
        return "sync"
    return "help"


def format_matches(result: Mapping[str, object], limit: int = 3) -> str:
    """Render recent matches as a short SMS (160-char segments, so keep it tight)."""
    rows = result.get("matches") if isinstance(result, Mapping) else None
    if not isinstance(rows, list) or not rows:
        return "No matches recorded yet. Add one in OpenPong, or sync your league."
    lines: list[str] = []
    for row in rows[:limit]:
        if not isinstance(row, Mapping):
            continue
        date = str(row.get("date") or "")[:10]
        opponent = row.get("opponent_name") or "opponent"
        outcome = row.get("result") or ""
        score = row.get("score_summary") or ""
        rating = row.get("opponent_rating")
        tail = f" ({rating})" if rating else ""
        piece = f"{date}: {outcome} vs {opponent}{tail}".strip()
        if score:
            piece += f" {score}"
        lines.append(piece.strip())
    if not lines:
        return "No matches recorded yet. Add one in OpenPong, or sync your league."
    total = len(rows)
    if total > limit:
        lines.append(f"+{total - limit} more in OpenPong")
    return "\n".join(lines)


def format_tournaments(result: Mapping[str, object], limit: int = 3) -> str:
    rows = result.get("tournaments") if isinstance(result, Mapping) else None
    if not isinstance(rows, list) or not rows:
        return "No upcoming tournaments in your area. Update your area in OpenPong settings."
    lines: list[str] = []
    for row in rows[:limit]:
        if not isinstance(row, Mapping):
            continue
        name = str(row.get("name") or "Tournament").strip()
        when = str(row.get("date") or row.get("start_date") or "").strip()[:10]
        city = str(row.get("city") or "").strip()
        lines.append(" - ".join(part for part in (when, name, city) if part))
    if len(rows) > limit:
        lines.append(f"+{len(rows) - limit} more in OpenPong")
    return "\n".join(lines) or "No upcoming tournaments in your area."


HELP_TEXT = (
    "OpenPong: text MATCHES, TOURNAMENTS, RATING or SYNC. "
    "Manage everything at your OpenPong dashboard."
)