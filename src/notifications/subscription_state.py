"""What the dispatchers do with a push subscription the push service has confirmed gone (HTTP 404 / 410).

Before: the dispatchers printed "leaving cleanup to a future pass" and tried the same dead subscription again at every later reminder, forever; the client's
reminders and preference stayed saved, so the user believed notifications were on while nothing could ever arrive.

Now: the stored subscription is marked INACTIVE (two attributes on its own item; the subscription itself is kept) and no send path tries it again. The user
recovers through the app exactly as before -- turning notifications off and on again subscribes the browser anew and PUTs a fresh item, which replaces the
whole item and so has no marker. A subscription replaced by the client while a push was in flight is never marked (the update is conditional on the endpoint).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from stores import remote_config_store


def reason_for(status_code: int | None) -> str:
    """The recorded reason for a confirmed-dead subscription."""
    return f"push_service_http_{status_code}" if status_code in (404, 410) else "push_service_gone"


def mark_inactive_after_expiry(client_id: str, subscription: Any, status_code: int | None, now: datetime) -> bool:
    """Mark the client's stored subscription inactive after a confirmed 404/410. Best effort: a failure is logged and never affects the send path. Returns whether the marker was written."""
    endpoint = subscription.get("endpoint") if isinstance(subscription, dict) else None
    if not isinstance(endpoint, str) or not endpoint:
        return False
    try:
        written = remote_config_store.mark_push_subscription_inactive(client_id, endpoint, at=now.isoformat(), reason=reason_for(status_code))
    except Exception as exc:  # noqa: BLE001 -- bookkeeping only; the push already failed and its claim is released by the caller
        print(f"Warning: could not mark the expired push subscription of client {client_id!r} inactive ({type(exc).__name__}): {exc}")
        return False
    if written:
        print(f"Push subscription of client {client_id!r} marked inactive (the push service reported it gone); the client must subscribe again")
    return written
