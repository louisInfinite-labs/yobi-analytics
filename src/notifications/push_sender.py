"""Web Push sending (Roadmap 4.6 delivery mechanism): encrypt and send one
push message to a stored browser subscription, using VAPID authentication
(RFC 8291/8292).

A thin wrapper around `pywebpush` — the actual message encryption and HTTP
delivery to the browser vendor's push service (e.g. Google FCM for
Chrome/Edge, Mozilla's push service for Firefox) is that library's job, not
reimplemented here. AWS is not involved in this delivery hop at all: this
module only needs to reach the push service directly, so it can run from
any Lambda/host once deployed — the currently-blocked piece is only the
Lambda/API Gateway wiring, same as every other Roadmap 4.x backend module.

This module's own job is narrower: (1) validate a stored subscription's
shape before ever handing it to pywebpush, since a subscription value
(Roadmap 4.5's opaque key/value store) is untrusted stored data that could
be corrupt or partially written, and (2) turn a raw `WebPushException` into
a decision the caller can act on — specifically, whether the push service
says the subscription is permanently gone (HTTP 404/410, so the caller
should stop retrying and delete it) versus a transient failure (worth
retrying later without deleting anything).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import requests
from py_vapid import Vapid, VapidException
from pywebpush import WebPushException, webpush

# The only Web Push services a real browser subscription can ever point to
# for this project's supported browsers (module docstring: Chrome/Edge via
# Google FCM, Firefox via Mozilla) — a stored subscription is untrusted data
# (Roadmap 4.5's opaque store), so an endpoint outside this allowlist is
# rejected rather than handed to pywebpush, which would otherwise POST the
# VAPID-signed payload to whatever host the stored value names.
_ALLOWED_PUSH_ENDPOINT_HOSTS = frozenset(
    {
        "fcm.googleapis.com",  # Chrome / Edge
        "updates.push.services.mozilla.com",  # Firefox
    }
)

# Bounded so a slow/unresponsive push service can't hang the caller (e.g. a
# Lambda invocation) indefinitely.
_PUSH_REQUEST_TIMEOUT_SECONDS = 10.0

# max_redirects=0 makes `requests` raise TooManyRedirects on any redirect
# response instead of following it — the push service's own endpoint URL is
# already the correct destination, so a redirect (which could point off the
# approved allowlist, including cross-origin) is always a reason to stop,
# never a reason to follow. Module-level and reused across calls so a warm
# Lambda container keeps its connection pool.
_PUSH_SESSION = requests.Session()
_PUSH_SESSION.max_redirects = 0


class InvalidSubscriptionError(ValueError):
    """Raised when a stored value is not a well-formed Web Push subscription."""


@dataclass(frozen=True)
class PushResult:
    """The outcome of one send_push_notification call — never raises, always returns this."""

    sent: bool
    subscription_expired: bool
    error: str | None = None


def parse_subscription(raw: Any) -> dict[str, Any]:
    """Validate a stored value is a well-formed Web Push subscription dict.

    Checks only the shape `pywebpush` actually requires (`endpoint`,
    `keys.p256dh`, `keys.auth`) — not every browser-specific field a
    PushSubscription object may carry.
    """
    if not isinstance(raw, dict):
        raise InvalidSubscriptionError("subscription must be an object")
    endpoint = raw.get("endpoint")
    if not isinstance(endpoint, str) or not endpoint:
        raise InvalidSubscriptionError("subscription.endpoint is required and must be a non-empty string")
    parsed_endpoint = urlparse(endpoint)
    if parsed_endpoint.scheme != "https" or parsed_endpoint.hostname not in _ALLOWED_PUSH_ENDPOINT_HOSTS:
        raise InvalidSubscriptionError(
            f"subscription.endpoint must be an HTTPS URL from an approved Web Push service "
            f"({sorted(_ALLOWED_PUSH_ENDPOINT_HOSTS)}), got {endpoint!r}"
        )
    keys = raw.get("keys")
    if not isinstance(keys, dict):
        raise InvalidSubscriptionError("subscription.keys is required and must be an object")
    for key_name in ("p256dh", "auth"):
        value = keys.get(key_name)
        if not isinstance(value, str) or not value:
            raise InvalidSubscriptionError(f"subscription.keys.{key_name} is required and must be a non-empty string")
    return {"endpoint": endpoint, "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]}}


def build_payload(*, title: str, body: str, data: dict[str, Any] | None = None) -> str:
    """Build the JSON payload string the frontend service worker's push handler expects."""
    if not title:
        raise ValueError("title is required")
    if not body:
        raise ValueError("body is required")
    payload: dict[str, Any] = {"title": title, "body": body}
    if data is not None:
        payload["data"] = data
    # ensure_ascii=False: a notification title/body carrying a creator's
    # Japanese/Chinese name (Roadmap 1.1's Unicode requirement) must not be
    # escaped into \uXXXX sequences.
    return json.dumps(payload, ensure_ascii=False)


def _load_vapid_signer(vapid_private_key: str) -> Vapid | str:
    """The key in the form `webpush()` accepts: a parsed `Vapid` for PEM text, else the string unchanged.

    `get_vapid_credentials` returns the key as PEM TEXT (that is what the secret holds). `webpush(vapid_private_key=<str>)` only takes a
    file path or a raw/DER base64 string -- given PEM text it fails with "Could not deserialize key data" -- so PEM is parsed here, in
    memory, into the `Vapid` object `webpush()` also accepts. The key is never written to disk, logged or put in an error message.
    """
    key = vapid_private_key.strip()
    if "-----BEGIN" in key:
        return Vapid.from_pem(key.encode("utf-8"))
    return vapid_private_key


def send_push_notification(
    subscription: dict[str, Any],
    *,
    title: str,
    body: str,
    data: dict[str, Any] | None,
    vapid_private_key: str,
    vapid_claims: dict[str, str],
) -> PushResult:
    """Send one Web Push notification. Never raises — every failure comes back as a PushResult.

    A 404/410 response means the push service has permanently discarded
    this subscription (the browser uninstalled it, revoked permission, or
    it expired) — the caller should delete the stored subscription rather
    than retry it. Any other failure (network issue, push service hiccup,
    a malformed stored subscription) is reported as not expired, since
    retrying later — or fixing the stored value — may still succeed.
    """
    try:
        parsed = parse_subscription(subscription)
        payload = build_payload(title=title, body=body, data=data)
    except (InvalidSubscriptionError, TypeError, ValueError) as exc:
        return PushResult(sent=False, subscription_expired=False, error=str(exc))

    try:
        vapid_signer = _load_vapid_signer(vapid_private_key)
    except (ValueError, VapidException) as exc:
        # Only the exception TYPE is reported: its text could echo key material.
        return PushResult(sent=False, subscription_expired=False, error=f"VAPID private key could not be loaded ({type(exc).__name__})")

    try:
        webpush(
            subscription_info=parsed,
            data=payload,
            vapid_private_key=vapid_signer,
            vapid_claims=dict(vapid_claims),
            timeout=_PUSH_REQUEST_TIMEOUT_SECONDS,
            requests_session=_PUSH_SESSION,
        )
    except WebPushException as exc:
        status_code = exc.response.status_code if exc.response is not None else None
        return PushResult(sent=False, subscription_expired=status_code in (404, 410), error=str(exc))
    except (ValueError, VapidException) as exc:
        # Signing the VAPID claims or encrypting for a malformed stored subscription key failed before anything was sent: a failed send
        # for THIS subscription, never an exception that ends the caller's whole run.
        return PushResult(sent=False, subscription_expired=False, error=f"push could not be prepared ({type(exc).__name__})")
    except requests.RequestException as exc:
        # A transport-level failure (timeout, connection error, or a
        # rejected redirect from _PUSH_SESSION's max_redirects=0) never
        # reached the push service well enough to know the subscription is
        # gone — always transient, matching the "not expired" branch above.
        return PushResult(sent=False, subscription_expired=False, error=str(exc))

    return PushResult(sent=True, subscription_expired=False)
