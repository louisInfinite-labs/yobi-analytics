"""Heartbeat / Online Status request handling (Roadmap 4.4).

Pure request-handling logic, with no AWS Lambda/API Gateway/DynamoDB
dependency of its own — mirrors read_api.py's split (Roadmap 2.2/3.4): this
module is the part that's fully testable locally, and an actual Lambda
entry point/API Gateway route plus a DynamoDB write in front of it is a
deployment step, not additional logic. Shared by both clients (Roadmap
Phase 4's dual-client note): a heartbeat POST body only ever carries
`clientId`/`appVersion` and never says which kind of client sent it.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

# Roadmap 4.4: lastSeenAt within 2 minutes => ONLINE, older => OFFLINE.
ONLINE_THRESHOLD_SECONDS = 120


class ClientError(ValueError):
    """A clean, safe-to-surface 4xx error for a malformed/invalid heartbeat request.

    Every field is untrusted input from a public URL (mirrors read_api.py's
    ClientError): raised before any value reaches parsing/storage code that
    could otherwise raise an unhandled exception or leak a stack trace.
    """


def parse_client_id(raw: Any) -> str:
    """Validate a clientId field is a non-empty string (Roadmap 4.3's anonymous UUID)."""
    if not isinstance(raw, str) or not raw:
        raise ClientError("clientId is required and must be a non-empty string")
    return raw


def parse_app_version(raw: Any) -> str:
    """Validate an appVersion field is a non-empty string."""
    if not isinstance(raw, str) or not raw:
        raise ClientError("appVersion is required and must be a non-empty string")
    return raw


def record_heartbeat(body: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    """Validate a heartbeat POST body and return the record a caller should persist.

    `lastSeenAt` is always this server's own current time, never taken from
    the request body — trusting a client-supplied timestamp would let a
    client with a skewed or spoofed clock misreport its own online status.
    `now` is injectable for tests; a real caller leaves it unset and gets
    `datetime.now(timezone.utc)`.
    """
    client_id = parse_client_id(body.get("clientId"))
    app_version = parse_app_version(body.get("appVersion"))
    last_seen_at = (now or datetime.now(timezone.utc)).isoformat()
    return {"clientId": client_id, "lastSeenAt": last_seen_at, "appVersion": app_version}


def online_status(last_seen_at: str, *, now: datetime | None = None) -> str:
    """Return "online" or "offline" for a stored lastSeenAt per Roadmap 4.4's freshness rule.

    `last_seen_at` is untrusted stored/passed-through input, not a value
    this module just produced, so it is validated the same as any other
    external value rather than assumed well-formed.
    """
    if not isinstance(last_seen_at, str) or not last_seen_at:
        raise ClientError("lastSeenAt is required and must be a non-empty ISO 8601 timestamp string")
    try:
        seen = datetime.fromisoformat(last_seen_at)
    except ValueError:
        raise ClientError(f"lastSeenAt is not a valid ISO 8601 timestamp: {last_seen_at!r}") from None
    if seen.tzinfo is None:
        raise ClientError(f"lastSeenAt must include a UTC offset: {last_seen_at!r}")

    reference = now or datetime.now(timezone.utc)
    age_seconds = (reference - seen).total_seconds()
    return "online" if age_seconds <= ONLINE_THRESHOLD_SECONDS else "offline"
