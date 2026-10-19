"""The shared 15-minute scheduled dispatcher for new-video pushes.

Runs on a UTC :00/:30 schedule (terraform/eventbridge.tf, `new_video_dispatch`) as a `mode` of the existing notification
dispatcher Lambda; live reminders stay on that Lambda's own 1-minute run and never touch the code below.

Each run is one TICK. Delivery slots are half hours of each client's OWN local day (its IANA `notificationTimeZone` + the local
`deliveryWindows`), so a run:

1. loads the recent new-video events (notification_events_store), deduplicated by video; with none, it stops here -- nothing
   needs the client index at all;
2. lists the IANA zones that have recipients (one tiny Query), works out for each which local half-hour slot(s) this tick starts
   (delivery_slots.due_local_slots -- daylight saving and unusual offsets are handled there, nothing is re-indexed when an offset
   changes) and asks the slot-recipient index (notification_slot_store) who chose each -- bounded Queries, never a scan of all clients;
3. for each such client: re-reads its stored preference (the source of truth; the index only says who to look at), checks it
   is still enabled, still in that zone and still lists that slot, and delivers every pending event the client wants, through the same claim -> send -> confirm/release
   delivery log the dispatcher always used (notification_delivery_log_store), keyed by (clientId, videoId). That key is the
   notification's logical identity: it makes a video reach a client at most once no matter how many slots, windows, retries or
   overlapping runs touch it, and it keeps every row written before this scheduler existed valid.

A client never receives an event that had already come due (its next delivery window had passed) before the client's current
enabled stretch began (`activeSince`), so turning notifications OFF and ON again never replays what came due meanwhile -- while an
event still waiting for its window when notifications come back ON is delivered normally.

A run that cannot finish before the Lambda's deadline stops starting new clients; the rest are served by their next slot (events
stay deliverable for _EVENT_LOOKBACK_DAYS), late rather than lost. A client whose slot passes while muted or in quiet hours is
treated the same way: nothing is recorded, so its next slot delivers.
"""

from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from notifications import notification_payload
from notifications import notification_dispatch
from notifications import notification_text
from notifications import push_sender
from notifications.delivery_slots import due_local_slots, floor_to_tick, slot_start_time
from ops.config import get_vapid_credentials
from stores import notification_delivery_log_store
from stores import notification_events_store
from stores import notification_slot_store
from stores import remote_config_store
from tracking.creator_master import load_creators
from tracking.video_master import CONTENT_TYPE_SHORT

MODE = "new_video_slots"

_NOTIFICATION_PREFERENCE_KEY = "notificationPreference"
_PUSH_SUBSCRIPTION_KEY = "pushSubscription"

# Must match main.py's COLLECTION_TIMEZONE: Video.discovered_at is always stamped in this zone, and
# notification_events_store partitions its eventDate by that same timestamp's own calendar date.
_EVENT_TIMEZONE = ZoneInfo("Asia/Tokyo")

# How many past calendar days' events remain deliverable -- bounds each run's DynamoDB reads. A video not delivered to a client
# within this window (it stayed muted/offline, or no slot of its passed in time) is treated as stale rather than queued forever.
_EVENT_LOOKBACK_DAYS = 3

# A scheduler retry can arrive late; beyond this the stale scheduled tick is ignored and the run uses the current tick instead.
_MAX_TICK_LAG = timedelta(hours=2)

# Stop starting new clients this close to the Lambda's deadline so the invocation ends cleanly.
_DEADLINE_MARGIN_MS = 20_000


def run(event: dict[str, Any], context: Any, *, now: datetime | None = None) -> dict[str, Any]:
    """Deliver the pending new-video events to every client whose chosen slot this tick is in."""
    now = now or datetime.now(timezone.utc)
    tick = resolve_tick(event, now)
    summary: dict[str, Any] = {
        "statusCode": 200,
        "mode": MODE,
        "tick": tick.isoformat(),
        "events": 0,
        "zones": 0,
        "slotsServed": 0,
        "recipients": 0,
        "delivered": 0,
        "staleIndexEntries": 0,
        "stoppedEarly": False,
    }

    events = pending_events(tick)
    summary["events"] = len(events)
    if not events:
        return summary

    creators_by_id = {creator.creator_id: creator for creator in load_creators()}
    vapid_private_key, vapid_claims = get_vapid_credentials()

    zones = notification_slot_store.list_zones()
    summary["zones"] = len(zones)
    for zone in zones:
        try:
            due_slots = due_local_slots(tick, zone)
        except (ZoneInfoNotFoundError, ValueError):
            print(f"Warning: ignoring unknown time zone {zone!r} in the slot-recipient index")
            continue
        for slot in due_slots:
            summary["slotsServed"] += 1
            for recipient in notification_slot_store.list_recipients(zone, slot):
                if _near_deadline(context):
                    summary["stoppedEarly"] = True
                    print(f"Warning: stopping before the Lambda deadline at tick {tick.isoformat()}; later clients wait for their next slot")
                    return summary
                outcome = _serve_recipient(
                    recipient,
                    zone=zone,
                    slot=slot,
                    tick=tick,
                    events=events,
                    creators_by_id=creators_by_id,
                    vapid_private_key=vapid_private_key,
                    vapid_claims=vapid_claims,
                )
                if outcome is None:
                    summary["staleIndexEntries"] += 1
                    continue
                summary["recipients"] += 1
                summary["delivered"] += outcome
    return summary


def resolve_tick(event: dict[str, Any] | None, now: datetime) -> datetime:
    """The UTC :00/:15/:30/:45 tick this run serves: the schedule's own scheduled time when it is sane, else the current quarter hour.

    Using the scheduled time (not the wall clock) keeps a run that starts a few seconds late in the slot it was scheduled for.
    """
    raw = (event or {}).get("scheduledTime")
    if isinstance(raw, str):
        try:
            scheduled = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            scheduled = None
        if scheduled is not None and scheduled.tzinfo is not None and timedelta(0) <= now - scheduled <= _MAX_TICK_LAG:
            return floor_to_tick(scheduled)
        if scheduled is not None:
            print(f"Warning: ignoring scheduledTime {raw!r} (not within {_MAX_TICK_LAG} before now); using the current tick")
    return floor_to_tick(now)


def pending_events(tick: datetime) -> list[dict[str, Any]]:
    """Recent events that may still be delivered at `tick`: eligible, already discovered, one per video, oldest first."""
    local_today = tick.astimezone(_EVENT_TIMEZONE).date()
    earliest_by_video: dict[str, dict[str, Any]] = {}
    for day_offset in range(_EVENT_LOOKBACK_DAYS):
        event_date = (local_today - timedelta(days=day_offset)).isoformat()
        for item in notification_events_store.list_events_for_date(event_date):
            if item.get("notificationEligible") is False:
                continue
            discovered_at = datetime.fromisoformat(item["discoveredAt"])  # compared as instants: the offsets may differ
            if discovered_at > tick:
                continue
            kept = earliest_by_video.get(item["videoId"])
            if kept is None or discovered_at < datetime.fromisoformat(kept["discoveredAt"]):
                earliest_by_video[item["videoId"]] = item
    return sorted(earliest_by_video.values(), key=lambda item: (datetime.fromisoformat(item["discoveredAt"]), item["videoId"]))


def _record_updated_at(record: dict[str, Any]) -> datetime | None:
    """A stored remote-config record's own updatedAt as an aware datetime, or None when absent/unreadable."""
    raw = record.get("updatedAt")
    if not isinstance(raw, str):
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def _near_deadline(context: Any) -> bool:
    remaining = getattr(context, "get_remaining_time_in_millis", None)
    return remaining is not None and remaining() < _DEADLINE_MARGIN_MS


def _slot_schedule(preference: notification_dispatch.NotificationPreference) -> notification_dispatch.NotificationPreference:
    """The preference as the window logic must see it: delivery times are exactly the client's (normalized) local slot starts.

    The windows stay wall-clock times in the client's own IANA zone, so next_delivery_window_utc converts them through that zone
    (daylight saving included). Only the window calculation uses this view; quiet hours and every other rule read the real preference.
    """
    return dataclasses.replace(preference, delivery_windows=tuple(slot_start_time(slot) for slot in preference.delivery_slots))


def _serve_recipient(
    recipient: notification_slot_store.SlotRecipient,
    *,
    zone: str,
    slot: int,
    tick: datetime,
    events: list[dict[str, Any]],
    creators_by_id: dict[str, Any],
    vapid_private_key: str,
    vapid_claims: dict[str, str],
) -> int | None:
    """Deliver one client's pending events for this slot. Returns how many were sent, or None for a stale index entry."""
    client_id = recipient.client_id
    record = remote_config_store.get_remote_config(client_id, _NOTIFICATION_PREFERENCE_KEY)
    if record is None:
        return None
    try:
        preference = notification_dispatch.parse_notification_preference(record["value"])
    except notification_dispatch.ClientError as exc:
        print(f"Warning: skipping client {client_id!r} with an invalid stored notification preference: {exc}")
        return 0
    # A preference stored before activation tracking existed has no newVideoActivatedAt: bound it by its own last write so the
    # 3-day lookback is never replayed for it (see notification_dispatch.with_legacy_new_video_activation).
    preference = notification_dispatch.with_legacy_new_video_activation(preference, stored_at=_record_updated_at(record))
    # The index only says who to look at. The stored preference decides: a client that has since turned OFF, moved to another time zone
    # or dropped this slot (an index write that outran a failed preference write, or one not yet cleaned up) is skipped.
    if not preference.enabled or preference.time_zone != zone or slot not in preference.delivery_slots:
        return None

    subscription_record = remote_config_store.get_remote_config(client_id, _PUSH_SUBSCRIPTION_KEY)
    if subscription_record is None:
        return 0  # nothing to deliver to
    subscription = subscription_record["value"]

    active_since = datetime.fromisoformat(recipient.active_since)
    schedule = _slot_schedule(preference)
    candidates = [
        event
        for event in events
        if notification_dispatch.next_delivery_window_utc(schedule, after=datetime.fromisoformat(event["discoveredAt"])) > active_since
    ]
    if not candidates:
        return 0

    already_handled = notification_delivery_log_store.delivered_video_ids(
        client_id, [candidate["videoId"] for candidate in candidates], now=tick
    )
    delivered = 0
    for candidate in candidates:
        if deliver_new_video_if_due(
            candidate,
            already_handled=already_handled,
            client_id=client_id,
            preference=preference,
            schedule=schedule,
            subscription=subscription,
            creators_by_id=creators_by_id,
            now=tick,
            vapid_private_key=vapid_private_key,
            vapid_claims=vapid_claims,
        ):
            delivered += 1
    return delivered


def deliver_new_video_if_due(
    candidate: dict[str, Any],
    *,
    already_handled: set[str],
    client_id: str,
    preference: notification_dispatch.NotificationPreference,
    schedule: notification_dispatch.NotificationPreference,
    subscription: Any,
    creators_by_id: dict[str, Any],
    now: datetime,
    vapid_private_key: str,
    vapid_claims: dict[str, str],
) -> bool:
    """Send one candidate event to one client if it is due, and record it. Returns whether it was sent.

    Only called for a client whose global switch is ON (the slot index never holds a disabled client), so a master-OFF
    suppression row is no longer needed here: the client's `activeSince` stops it from ever replaying what it missed. A creator
    whose per-creator new-video switch is OFF is still recorded as suppressed and skipped for good, so turning that switch back ON
    never replays it from the lookback window. An event whose delivery window has not arrived yet is left alone. `schedule` is the
    client's local slots (see _slot_schedule) used only for the window check; `preference` drives every other rule.
    """
    video_id = candidate["videoId"]
    if video_id in already_handled:
        return False

    discovered_at = datetime.fromisoformat(candidate["discoveredAt"])
    eligible_at = notification_dispatch.next_delivery_window_utc(schedule, after=discovered_at)
    if now < eligible_at:
        return False
    if not notification_dispatch.is_new_video_wanted(preference, candidate["creatorId"], content_type=candidate.get("contentType")):
        # The client turned this creator's 新片 switch OFF -- or, for a Short, did not enable this creator in the Short card
        # (the default): an event that comes due while it is OFF is skipped for good.
        notification_delivery_log_store.mark_suppressed(client_id, video_id, now.isoformat())
        return False
    if candidate.get("contentType") != CONTENT_TYPE_SHORT and not notification_dispatch.is_new_video_after_activation(
        preference, candidate["creatorId"], discovered_at=discovered_at
    ):
        # Discovered before this creator's new-video switch was (last) turned on -- or no activation is recorded at all: old news,
        # never a first-enable / re-enable backlog. Recorded as suppressed like the other skipped-for-good cases, so it stays settled
        # whatever the preference later becomes. (A Short has its own Short-card rules and is unchanged.) This is the per-creator
        # boundary; the client-level `activeSince` filter in _serve_recipient is a separate, coarser one and both must hold.
        notification_delivery_log_store.mark_suppressed(client_id, video_id, now.isoformat())
        return False
    if not notification_dispatch.should_notify_now(preference, candidate["creatorId"], now=now):
        return False

    # Claimed *before* sending (not just recorded after a successful send): this is the atomic gate that stops two overlapping
    # runs from both sending. A lost claim means a concurrent run already owns this (client, video) pair.
    if not notification_delivery_log_store.mark_delivered(client_id, video_id, now.isoformat()):
        return False

    creator = creators_by_id.get(candidate["creatorId"])
    text = notification_text.new_video_notification(
        locale=preference.locale,
        creator_name=creator.display_name if creator else None,
        video_title=candidate.get("title"),
    )
    result = push_sender.send_push_notification(
        subscription,
        title=text.title,
        body=text.body,
        data=notification_payload.notification_data(
            {"videoId": video_id},
            video_id=video_id,
            creator_id=candidate["creatorId"],
            creators_by_id=creators_by_id,
            # Only an event that already carries the stored Video Master thumbnail can confirm Maxres; none is looked up or probed here.
            known_thumbnail_url=candidate.get("thumbnailUrl"),
        ),
        vapid_private_key=vapid_private_key,
        vapid_claims=vapid_claims,
    )
    if result.subscription_expired:
        print(f"Push subscription expired for client {client_id!r}; leaving cleanup to a future pass")
        notification_delivery_log_store.release_claim(client_id, video_id)
        return False
    if not result.sent:
        print(f"Warning: push send failed for client {client_id!r}, video {video_id!r}: {result.error}")
        notification_delivery_log_store.release_claim(client_id, video_id)
        return False

    notification_delivery_log_store.confirm_delivered(client_id, video_id, now.isoformat())
    return True
