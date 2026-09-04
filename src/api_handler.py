"""AWS Lambda entry point for the Phase 4 HTTP API (Roadmap 4.1/4.4/4.5).

Routes an API Gateway HTTP API (payload format 2.0) proxy event to the
already-implemented, storage-agnostic request handlers in read_api.py,
heartbeat_api.py, and remote_config_api.py, and to the new DynamoDB storage
layers in heartbeat_store.py/remote_config_store.py that actually persist a
write. This module is the "deployment step, not additional logic" every one
of those modules' docstrings describes as still missing — it adds no new
business logic of its own, only proxy-event parsing, routing by `routeKey`,
and mapping each module's own ClientError family to an HTTP status code.

Routing is keyed on `event["routeKey"]` (e.g. "GET /videos/{videoId}/growth")
rather than a hand-rolled path matcher, because API Gateway HTTP API already
does path-template matching and hands back the exact route string configured
for that route — duplicating that logic here would be redundant and could
drift out of sync with the actual configured routes.

POST /remote-config authors state on behalf of an arbitrary clientId rather
than a client reporting its own — Roadmap 4.5 says "the Dashboard is the
sole author", so this route (and the admin stats route below) requires a
shared admin API key (YOBI_ADMIN_API_KEY) in an X-Admin-Key request header.

Every other write route is self-service: a client can only ever act on the
clientId named in its own path/body, the same trust level as POST
/heartbeat (a client reporting its own liveness). This includes the
push-subscription and notification-preference routes — Roadmap 4.6's own
example ("clientId A turns one creator's notifications off") is one client
managing its own preference, not an admin managing someone else's — so
these do not require the admin key, matching Roadmap 4.4's "Google login is
not required" and 4.3's fully anonymous clientId design.
"""

from __future__ import annotations

import base64
import hmac
import json
import os
from typing import Any, Callable

import heartbeat_api
import heartbeat_store
import notification_dispatch
import push_sender
import read_api
import remote_config_api
import remote_config_store

# Roadmap 4.5: only a route that authors config for an arbitrary clientId
# (or reveals aggregate data across every client) needs this — a route
# where a client only ever acts on its own clientId does not, by design
# (see module docstring).
_ADMIN_PROTECTED_ROUTES = frozenset({"POST /remote-config", "GET /admin/heartbeat-stats"})
_ADMIN_KEY_HEADER = "x-admin-key"

_PUSH_SUBSCRIPTION_KEY = "pushSubscription"
_NOTIFICATION_PREFERENCE_KEY = "notificationPreference"

# Every module's own ClientError-family exception independently (each
# mirrors read_api.py's original rather than sharing a base class) — every
# one means the same thing: a clean, safe-to-surface 4xx for malformed or
# invalid input.
_CLIENT_ERROR_TYPES = (
    read_api.ClientError,
    heartbeat_api.ClientError,
    remote_config_api.ClientError,
    notification_dispatch.ClientError,
    push_sender.InvalidSubscriptionError,
)


class MalformedRequestError(read_api.ClientError):
    """A clean 4xx for a request this module itself cannot parse (e.g. non-JSON body).

    Subclasses read_api.ClientError purely so it's covered by the same
    _CLIENT_ERROR_TYPES tuple without needing a fourth entry.
    """


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Route one API Gateway HTTP API proxy event to its handler and return an HTTP API v2 response.

    Never raises — every error path (unknown route, malformed input, an
    unexpected exception from a handler) becomes a JSON error response with
    an appropriate status code, since letting an exception escape here would
    surface as an opaque API Gateway 500 with no diagnosable body.
    """
    route_key = event.get("routeKey")
    handler = _ROUTES.get(route_key)
    if handler is None:
        return _json_response(404, {"error": f"No such route: {route_key!r}"})

    try:
        if route_key in _ADMIN_PROTECTED_ROUTES:
            auth_error = _check_admin_key(event)
            if auth_error is not None:
                return auth_error

        result = handler(event)
    except read_api.VideoNotFoundError as exc:
        return _json_response(404, {"error": str(exc)})
    except _CLIENT_ERROR_TYPES as exc:
        return _json_response(400, {"error": str(exc)})
    except Exception as exc:  # noqa: BLE001 - deliberate catch-all, see docstring
        print(f"Unhandled error in api_handler for route {route_key!r}: {exc!r}")
        return _json_response(500, {"error": "Internal server error"})

    return _json_response(200, result)


def _handle_get_video_growth(event: dict[str, Any]) -> dict[str, Any]:
    return read_api.get_video_growth(_merged_params(event))


def _handle_get_creator_trending(event: dict[str, Any]) -> dict[str, Any]:
    return read_api.get_creator_trending(_merged_params(event))


def _handle_get_organization_trending(event: dict[str, Any]) -> dict[str, Any]:
    return read_api.get_organization_trending(_merged_params(event))


def _handle_post_heartbeat(event: dict[str, Any]) -> dict[str, Any]:
    """Validate and record one heartbeat, returning the record actually stored."""
    record = heartbeat_api.record_heartbeat(_json_body(event))
    heartbeat_store.put_heartbeat(record)
    return record


def _handle_get_heartbeat_status(event: dict[str, Any]) -> dict[str, Any]:
    """Return one client's online/offline status, using its own clientId path parameter."""
    params = _merged_params(event)
    client_id = heartbeat_api.parse_client_id(params.get("clientId"))
    stored = heartbeat_store.get_heartbeat(client_id)
    if stored is None:
        raise heartbeat_api.ClientError(f"No heartbeat recorded for clientId {client_id!r}")
    return {
        "clientId": client_id,
        "status": heartbeat_api.online_status(stored["lastSeenAt"]),
        "lastSeenAt": stored["lastSeenAt"],
        "appVersion": stored.get("appVersion"),
    }


def _handle_post_remote_config(event: dict[str, Any]) -> dict[str, Any]:
    """Validate and write one remote-config (clientId, key) -> value entry.

    Admin-protected (see `_ADMIN_PROTECTED_ROUTES`): this route authors
    config on behalf of an arbitrary clientId, so `lambda_handler` requires
    a valid X-Admin-Key header before it reaches this handler.
    """
    record = remote_config_api.write_remote_config(_json_body(event))
    remote_config_store.put_remote_config(record)
    return record


def _handle_get_remote_config(event: dict[str, Any]) -> dict[str, Any]:
    """Return one client's stored config: one key's record, or every stored key when `key` is absent.

    A generic (no explicit `key`) read excludes `_PUSH_SUBSCRIPTION_KEY` —
    its value carries the Web Push subscription's own endpoint/encryption
    material (Roadmap 4.6), which has no reason to round-trip through a
    "list everything for this clientId" read that this route (like every
    other self-service route) lets anyone call for any known clientId. An
    explicit `?key=pushSubscription` read is unaffected.
    """
    client_id, key = remote_config_api.parse_read_query(_merged_params(event))
    if key is not None:
        record = remote_config_store.get_remote_config(client_id, key)
        return {"clientId": client_id, "configs": [record] if record is not None else []}
    configs = [
        record for record in remote_config_store.list_remote_config(client_id) if record["key"] != _PUSH_SUBSCRIPTION_KEY
    ]
    return {"clientId": client_id, "configs": configs}


def _handle_put_push_subscription(event: dict[str, Any]) -> dict[str, Any]:
    """Self-service: a client stores its own Web Push subscription (Roadmap 4.6), keyed by its own clientId path parameter."""
    client_id = heartbeat_api.parse_client_id(_merged_params(event).get("clientId"))
    subscription = push_sender.parse_subscription(_json_body(event))
    record = remote_config_api.write_remote_config(
        {"clientId": client_id, "key": _PUSH_SUBSCRIPTION_KEY, "value": subscription}
    )
    remote_config_store.put_remote_config(record)
    return record


def _handle_delete_push_subscription(event: dict[str, Any]) -> dict[str, Any]:
    """Self-service: a client retracts its own stored Web Push subscription (e.g. on unsubscribe)."""
    client_id = heartbeat_api.parse_client_id(_merged_params(event).get("clientId"))
    remote_config_store.delete_remote_config(client_id, _PUSH_SUBSCRIPTION_KEY)
    return {"clientId": client_id, "key": _PUSH_SUBSCRIPTION_KEY, "deleted": True}


def _handle_put_notification_preference(event: dict[str, Any]) -> dict[str, Any]:
    """Self-service: a client sets its own notification preference (Roadmap 4.6), keyed by its own clientId path parameter."""
    client_id = heartbeat_api.parse_client_id(_merged_params(event).get("clientId"))
    raw_preference = _json_body(event)
    notification_dispatch.parse_notification_preference(raw_preference)
    record = remote_config_api.write_remote_config(
        {"clientId": client_id, "key": _NOTIFICATION_PREFERENCE_KEY, "value": raw_preference}
    )
    remote_config_store.put_remote_config(record)
    return record


def _handle_get_admin_heartbeat_stats(event: dict[str, Any]) -> dict[str, Any]:
    """Admin-only aggregate: how many distinct clients have ever sent a heartbeat, and how many are online now."""
    records = heartbeat_store.list_all()
    online_count = sum(1 for record in records if heartbeat_api.online_status(record["lastSeenAt"]) == "online")
    return {"totalClients": len(records), "onlineNow": online_count}


_ROUTES: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "GET /videos/{videoId}/growth": _handle_get_video_growth,
    "GET /creators/{creatorId}/trending": _handle_get_creator_trending,
    "GET /organizations/{organization}/trending": _handle_get_organization_trending,
    "POST /heartbeat": _handle_post_heartbeat,
    "GET /heartbeat/{clientId}/status": _handle_get_heartbeat_status,
    "POST /remote-config": _handle_post_remote_config,
    "GET /remote-config": _handle_get_remote_config,
    "PUT /clients/{clientId}/push-subscription": _handle_put_push_subscription,
    "DELETE /clients/{clientId}/push-subscription": _handle_delete_push_subscription,
    "PUT /clients/{clientId}/notification-preference": _handle_put_notification_preference,
    "GET /admin/heartbeat-stats": _handle_get_admin_heartbeat_stats,
}


def _check_admin_key(event: dict[str, Any]) -> dict[str, Any] | None:
    """Return an error response if this request's admin key is missing/wrong, else None.

    Fails closed if YOBI_ADMIN_API_KEY itself isn't configured (503, not a
    silently-open route) — an admin-protected route with no key configured
    is a deployment mistake, not "anyone may write". Uses a constant-time
    comparison so response timing can't be used to guess the key
    character-by-character.
    """
    expected = os.environ.get("YOBI_ADMIN_API_KEY")
    if not expected:
        print("Warning: YOBI_ADMIN_API_KEY is not set; refusing this admin-protected route until it is configured")
        return _json_response(503, {"error": "Admin write endpoint is not configured"})

    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    provided = headers.get(_ADMIN_KEY_HEADER)
    # Encoded to bytes so a non-ASCII header value can't raise TypeError out
    # of compare_digest (it only accepts ASCII-only str) — this now runs
    # inside lambda_handler's own try block as a second layer, but staying
    # byte-safe here keeps this function correct on its own too.
    if not provided or not hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8")):
        return _json_response(403, {"error": "Missing or invalid admin API key"})
    return None


def _merged_params(event: dict[str, Any]) -> dict[str, Any]:
    """Combine query-string and path parameters into one dict for a parse_* function.

    Path parameters are applied last (they win on a name collision) since a
    path template's own variable (e.g. `{clientId}`) is the authoritative
    source for that value on a route that has one — a same-named query
    parameter would only be a client's mistake, not an override.
    """
    params: dict[str, Any] = {}
    params.update(event.get("queryStringParameters") or {})
    params.update(event.get("pathParameters") or {})
    return params


def _reject_json_constant(constant: str) -> None:
    """Reject `json.loads`'s non-standard NaN/Infinity/-Infinity tokens.

    Python's json module accepts these as a JavaScript-compatible extension,
    but they aren't valid JSON and would otherwise slip a non-finite float
    into an opaque remote-config `value` (Roadmap 4.5) — one DynamoDB's own
    Decimal conversion cannot represent, turning a clean 400 here into an
    unhandled 500 later at write time instead.
    """
    raise ValueError(f"{constant} is not a valid JSON value")


def _json_body(event: dict[str, Any]) -> dict[str, Any]:
    """Parse the request body as a JSON object, raising a clean 4xx for anything else."""
    raw_body = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw_body = base64.b64decode(raw_body).decode("utf-8")
    try:
        body = json.loads(raw_body, parse_constant=_reject_json_constant)
    except (ValueError, TypeError) as exc:
        raise MalformedRequestError(f"Request body is not valid JSON: {exc}") from None
    if not isinstance(body, dict):
        raise MalformedRequestError("Request body must be a JSON object")
    return body


def _json_response(status_code: int, payload: dict[str, Any]) -> dict[str, Any]:
    """Build an API Gateway HTTP API v2 proxy response."""
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(payload),
    }
