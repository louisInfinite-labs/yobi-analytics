"""Scheduled Lambda entry point for the Phase 4.6 notification dispatcher.

Runs on a fixed EventBridge schedule (mirrors Roadmap 2.4's daily-collection
trigger pattern) rather than firing per-event, since Roadmap 4.6 explicitly
allows holding a near-real-time event until a client's next selected
delivery window — a poller that re-checks "is it time yet" each run is a
correct way to implement that; a one-shot per-event trigger would need its
own precise hold-and-refire scheduling machinery instead. Each run:

1. Loads every notification event from the last _EVENT_LOOKBACK_DAYS
   calendar days (notification_events_store.py) — a video becomes a
   candidate once, at discovery, and stays one until every subscribed
   client has either been notified or the lookback window ages it out.
2. Loads every client that has a stored NotificationPreference (Roadmap
   4.6's opaque value, under remote_config_store.py's generic store).
3. For each (client, event) pair not already recorded in
   notification_delivery_log_store.py: skips it — without marking anything
   delivered, so a later run naturally retries — if the event's own next
   eligible delivery window (notification_dispatch.next_delivery_window_utc)
   hasn't arrived yet, or if notification_dispatch.should_notify_now says
   this client is currently suppressed (disabled/overridden creator,
   temporary mute, quiet hours). Otherwise sends via push_sender.py and
   marks the pair delivered.

A client with a stored preference but no stored push subscription is
skipped entirely (nothing to deliver to), not treated as an error — Roadmap
4.5/4.6 don't require subscribing to push before holding a preference.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import notification_delivery_log_store
import notification_dispatch
import notification_events_store
import push_sender
import remote_config_store
from config import get_vapid_credentials
from creator_master import load_creators

_NOTIFICATION_PREFERENCE_KEY = "notificationPreference"
_PUSH_SUBSCRIPTION_KEY = "pushSubscription"

# Must match main.py's COLLECTION_TIMEZONE: Video.discovered_at is always
# stamped in this zone, and notification_events_store.py partitions its
# eventDate by that same timestamp's own calendar date.
_EVENT_TIMEZONE = ZoneInfo("Asia/Tokyo")

# How many past calendar days' notification events remain delivery
# candidates — bounds this run's DynamoDB reads. A video not delivered to a
# given client within this window is treated as stale (e.g. that client
# stayed muted/offline for a long stretch) rather than queued forever.
_EVENT_LOOKBACK_DAYS = 3


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Check every pending (client, notification event) pair and deliver the ones that are due."""
    now = datetime.now(timezone.utc)
    candidate_events = _recent_events(now)
    if not candidate_events:
        return {"statusCode": 200, "checked": 0, "delivered": 0}

    creators_by_id = {creator.creator_id: creator for creator in load_creators()}
    preference_records = remote_config_store.list_by_key(_NOTIFICATION_PREFERENCE_KEY)
    vapid_private_key, vapid_claims = get_vapid_credentials()

    checked = 0
    delivered = 0
    for pref_record in preference_records:
        client_id = pref_record["clientId"]
        try:
            preference = notification_dispatch.parse_notification_preference(pref_record["value"])
        except notification_dispatch.ClientError as exc:
            print(f"Warning: skipping client {client_id!r} with an invalid stored notification preference: {exc}")
            continue

        subscription_record = remote_config_store.get_remote_config(client_id, _PUSH_SUBSCRIPTION_KEY)
        if subscription_record is None:
            continue

        for candidate in candidate_events:
            checked += 1
            if _deliver_if_due(
                candidate,
                client_id=client_id,
                preference=preference,
                subscription=subscription_record["value"],
                creators_by_id=creators_by_id,
                now=now,
                vapid_private_key=vapid_private_key,
                vapid_claims=vapid_claims,
            ):
                delivered += 1

    return {"statusCode": 200, "checked": checked, "delivered": delivered}


def _deliver_if_due(
    candidate: dict[str, Any],
    *,
    client_id: str,
    preference: notification_dispatch.NotificationPreference,
    subscription: Any,
    creators_by_id: dict[str, Any],
    now: datetime,
    vapid_private_key: str,
    vapid_claims: dict[str, str],
) -> bool:
    """Send one candidate event to one client if it's due, and record it. Returns whether it was sent."""
    video_id = candidate["videoId"]
    if notification_delivery_log_store.already_delivered(client_id, video_id):
        return False

    discovered_at = datetime.fromisoformat(candidate["discoveredAt"])
    eligible_at = notification_dispatch.next_delivery_window_utc(preference, after=discovered_at)
    if now < eligible_at:
        return False
    if not notification_dispatch.should_notify_now(preference, candidate["creatorId"], now=now):
        return False

    creator = creators_by_id.get(candidate["creatorId"])
    result = push_sender.send_push_notification(
        subscription,
        title=f"{creator.display_name} has a new video" if creator else "New video",
        body=candidate["title"],
        data={"videoId": video_id},
        vapid_private_key=vapid_private_key,
        vapid_claims=vapid_claims,
    )
    if result.subscription_expired:
        print(f"Push subscription expired for client {client_id!r}; leaving cleanup to a future pass")
        return False
    if not result.sent:
        print(f"Warning: push send failed for client {client_id!r}, video {video_id!r}: {result.error}")
        return False

    notification_delivery_log_store.mark_delivered(client_id, video_id, now.isoformat())
    return True


def _recent_events(now: datetime) -> list[dict[str, Any]]:
    """Every notification event from the last _EVENT_LOOKBACK_DAYS calendar days, in _EVENT_TIMEZONE."""
    local_today = now.astimezone(_EVENT_TIMEZONE).date()
    events: list[dict[str, Any]] = []
    for day_offset in range(_EVENT_LOOKBACK_DAYS):
        event_date = (local_today - timedelta(days=day_offset)).isoformat()
        events.extend(notification_events_store.list_events_for_date(event_date))
    return events
