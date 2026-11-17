"""Relay error types — each maps to exactly one clean failure, no fallbacks.

Per the owner's rule (and RELAY_ARCHITECTURE.md §7): one method per function,
or a clean error. These are raised deep in registry/proxy code and caught at
the FastAPI route boundary in server.py, which turns each into a single JSON
error shape: {"error": {"type": "...", "detail": "..."}}.
"""

from __future__ import annotations


class RelayError(Exception):
    """Base for all relay-raised errors. `error_type` is the wire-facing type."""

    error_type = "RelayError"
    status_code = 500

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail

    def to_dict(self) -> dict:
        return {"error": {"type": self.error_type, "detail": self.detail}}


class BadRegisterToken(RelayError):
    error_type = "BadRegisterToken"
    status_code = 401


# Alias: the register token is the pairing token in this port (docs/
# RELAY_ARCHITECTURE.md §2.1). Same failure, clearer name at call sites.
BadPairingToken = BadRegisterToken


class CompanionNotOnline(RelayError):
    error_type = "CompanionNotOnline"
    status_code = 404


class SessionConflict(RelayError):
    error_type = "SessionConflict"
    status_code = 409


class UnknownSession(RelayError):
    error_type = "UnknownSession"
    status_code = 404


class UnknownGate(RelayError):
    error_type = "UnknownGate"
    status_code = 404


class CompanionUnresponsive(RelayError):
    """The companion tunnel did not answer a proxied CDP RPC in time."""

    error_type = "CompanionUnresponsive"
    status_code = 504


class CompanionGone(RelayError):
    """The companion tunnel closed while a session was bound to it."""

    error_type = "CompanionGone"
    status_code = 502


class OperatorTokenNotConfigured(RelayError):
    """RELAY_OPERATOR_TOKEN is unset — S3 hardening fails closed, the control
    endpoints refuse rather than running open."""

    error_type = "OperatorTokenNotConfigured"
    status_code = 503


class BadOperatorToken(RelayError):
    """X-Operator-Token header missing or does not match RELAY_OPERATOR_TOKEN."""

    error_type = "BadOperatorToken"
    status_code = 401


class OwnerMismatch(RelayError):
    """Per-user pairing enforcement (docs/RELAY_ARCHITECTURE.md §2.3): the
    owner a session claims does not match the owner the pairing token was
    minted for. Refused in the relay, never only in the client."""

    error_type = "OwnerMismatch"
    status_code = 403


class PairingNotFound(RelayError):
    """No pairing (companion credential) exists for the requested owner."""

    error_type = "PairingNotFound"
    status_code = 404


class PairingStoreUnavailable(RelayError):
    """The pairing store could not be persisted (read-only FS / bad path).
    Minting fails closed rather than handing back a token that will not
    survive a restart."""

    error_type = "PairingStoreUnavailable"
    status_code = 503
