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

from pywebpush import WebPushException, webpush


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
    except (InvalidSubscriptionError, ValueError) as exc:
        return PushResult(sent=False, subscription_expired=False, error=str(exc))

    try:
        webpush(
            subscription_info=parsed,
            data=payload,
            vapid_private_key=vapid_private_key,
            vapid_claims=dict(vapid_claims),
        )
    except WebPushException as exc:
        status_code = exc.response.status_code if exc.response is not None else None
        return PushResult(sent=False, subscription_expired=status_code in (404, 410), error=str(exc))

    return PushResult(sent=True, subscription_expired=False)
