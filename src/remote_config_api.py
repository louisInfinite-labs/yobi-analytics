"""Remote Config request handling (Roadmap 4.5).

Pure request-handling logic, with no AWS Lambda/API Gateway/DynamoDB
dependency of its own — mirrors read_api.py's and heartbeat_api.py's split
(Roadmap 2.2/3.4/4.4): this module is the part that's fully testable
locally, and an actual Lambda entry point/API Gateway route plus a
DynamoDB read/write in front of it is a deployment step, not additional
logic.

Generic key/value store by design: the backend treats `key`/`value` as
opaque data and never interprets their meaning. The Dashboard (the sole
author, per Roadmap 4.5) and whichever client later reads a value back —
Dashboard or Yobi.exe, keyed by the Roadmap 4.3 `clientId` — are the ones
who agree on which keys exist and what a given key's value means; this
module only validates the request envelope (clientId/key non-empty, value
present), never a specific field's business meaning. This means adding a
new per-client setting never requires a backend schema change.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


class ClientError(ValueError):
    """A clean, safe-to-surface 4xx error for a malformed/invalid remote-config request.

    Every field is untrusted input from a public URL (mirrors read_api.py's
    and heartbeat_api.py's ClientError): raised before any value reaches
    parsing/storage code that could otherwise raise an unhandled exception
    or leak a stack trace.
    """


def parse_client_id(raw: Any) -> str:
    """Validate a clientId field is a non-empty string (Roadmap 4.3's anonymous UUID)."""
    if not isinstance(raw, str) or not raw:
        raise ClientError("clientId is required and must be a non-empty string")
    return raw


def parse_config_key(raw: Any) -> str:
    """Validate a config key field is a non-empty string.

    Only the envelope is checked here — the key's meaning (e.g.
    "creatorOverride.aizawa_ema") is defined by whichever client reads it
    back, not by this module.
    """
    if not isinstance(raw, str) or not raw:
        raise ClientError("key is required and must be a non-empty string")
    return raw


def write_remote_config(body: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    """Validate a remote-config write request and return the normalized record to persist.

    `value` is opaque to this module — present-but-any-JSON-type is the
    only requirement, since the backend does not interpret it. `now` is
    injectable for tests; a real caller leaves it unset and gets
    `datetime.now(timezone.utc)`.
    """
    client_id = parse_client_id(body.get("clientId"))
    key = parse_config_key(body.get("key"))
    if "value" not in body:
        raise ClientError("value is required")
    return {
        "clientId": client_id,
        "key": key,
        "value": body["value"],
        "updatedAt": (now or datetime.now(timezone.utc)).isoformat(),
    }


def parse_read_query(query: dict[str, Any]) -> tuple[str, str | None]:
    """Validate a remote-config read request's query parameters.

    Returns `(clientId, key)`; `key` is `None` when absent, meaning "every
    stored key for this clientId" rather than one specific key.
    """
    client_id = parse_client_id(query.get("clientId"))
    raw_key = query.get("key")
    key = parse_config_key(raw_key) if raw_key not in (None, "") else None
    return client_id, key
