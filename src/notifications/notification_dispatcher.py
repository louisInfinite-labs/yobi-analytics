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
   temporary mute, quiet hours). The one exception to "without marking
   anything": an event that comes due while the client's global
   notifications switch is OFF is recorded as suppressed, so turning the
   switch back ON never replays it. Otherwise atomically claims the pair via
   notification_delivery_log_store.mark_delivered's conditional write
   *before* sending — closing the race where two overlapping runs could
   both see "not yet delivered" and both push — then sends via
   push_sender.py: a successful send calls confirm_delivered() to make the
   record permanent, while a send that didn't actually succeed calls
   release_claim() so a later run can retry immediately. A claim that gets
   neither call (the invocation that made it terminated first — Lambda
   timeout, crash) expires on its own after
   notification_delivery_log_store._CLAIM_EXPIRY and becomes reclaimable,
   rather than looking permanently delivered with nothing ever actually
   sent.

A client with a stored preference but no stored push subscription is
skipped entirely (nothing to deliver to), not treated as an error — Roadmap
4.5/4.6 don't require subscribing to push before holding a preference.

Same run, same per-client loop: also resolves, for every stream in the
system-wide "streamSchedule" snapshot, which single reminder setting (if any)
applies to this client -- per-stream override > creator 全部 > creator +
the stream's matched topic > unset (live_reminder.resolve_effective_setting).
The CURRENT scheduledStartMs and the stream's topic always come from that
snapshot (live_reminder.StreamScheduleEntry), never from anything stored
inside a setting: a Holodex reschedule is picked up automatically on the
snapshot's next refresh. Sends any due start/advance live-reminder,
independent of the discovery-event loop above (a genuinely different
trigger: a stream's own scheduledStartMs, never discoveredAt). A reminder
is skipped -- never delayed or replayed -- if the client is muted or in
quiet hours at the moment it was meant to fire, or at the moment this run
would send it. This reuses this cadence as-is rather than a second schedule
-- now rate(1 minute), prepared in terraform/eventbridge.tf (not yet
applied) so _REMINDER_WINDOW can shrink to match and actually honour
"1min"/"10min" precisely, not just "30min"/"1hour".

Reminder EVALUATION (every dispatcher run) is deliberately decoupled from
how often Holodex is actually QUERIED: _refresh_and_load_stream_schedule
only calls read_api.get_live_streams() when the persisted snapshot's own
refreshedAt is older than _SCHEDULE_REFRESH_INTERVAL (15 minutes, this
Lambda's own rate(15 minutes) cadence before this change lowered the
*dispatch* schedule to rate(1 minute) for reminder evaluation -- see
_SCHEDULE_REFRESH_INTERVAL) -- a 1-minute dispatcher cadence does not mean a
1-minute Holodex cadence. One aggregate refresh per dispatcher run at most,
never per client, never per stream.

The "streamSchedule" snapshot is a full-replace write each successful
refresh (never merged), so a stream Holodex no longer returns (ended, or
beyond its own upcoming window) naturally ages out on the next refresh --
no separate expiry/TTL bookkeeping needed. A failed Holodex fetch leaves the
previously stored snapshot untouched rather than wiping it (see
_refresh_and_load_stream_schedule), so a transient outage degrades to
"slightly stale schedule data", never "no reminders at all".
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from stores import notification_delivery_log_store
from notifications import notification_dispatch
from stores import notification_events_store
from notifications import live_reminder
from notifications import push_sender
from stores import remote_config_store
from api import remote_config_api
from api import read_api
from api.holodex_client import HolodexAPIError
from api.holodex_normalization import HolodexNormalizationError
from ops.config import get_vapid_credentials, MissingHolodexApiKeyError
from tracking.creator_master import load_creators
from tracking.video_topics import OTHER_TOPIC, classify_video_topic

_NOTIFICATION_PREFERENCE_KEY = "notificationPreference"
_PUSH_SUBSCRIPTION_KEY = "pushSubscription"

# Matches this Lambda's own EventBridge rate (terraform/eventbridge.tf,
# rate(1 minute), prepared not yet applied) -- a reminder's fire window is
# [fire_at, fire_at + this), so it's always caught by the next run rather
# than skipped between two polls, while staying tight enough to honour
# "1min"/"10min" at their configured offset rather than merely eventually.
_REMINDER_WINDOW = timedelta(minutes=1)

# The notification body of each reminder. push_sender.build_payload REQUIRES a non-empty body, so a reminder pushed with
# body="" was rejected before it ever reached the push service ("body is required"): the claim was released and retried
# every minute until the fire window closed, i.e. no start/advance reminder was ever delivered.
_START_REMINDER_BODY = "The stream has started"
_ADVANCE_REMINDER_BODY_LABELS = {"1min": "1 minute", "10min": "10 minutes", "30min": "30 minutes", "1hour": "1 hour"}

# How stale the persisted "streamSchedule" snapshot may get before this run
# actually queries Holodex again -- reused, not invented: this Lambda's own
# EventBridge schedule (terraform/eventbridge.tf's notification_dispatch)
# ran at rate(15 minutes) before this change lowered it to rate(1 minute) so
# reminder EVALUATION could honour "1min"/"10min" precisely (see
# _REMINDER_WINDOW above). That pre-existing rate(15 minutes) is the
# product's own already-chosen cadence for how often this backend queries
# Holodex's /users/live for schedule data -- kept here as the Holodex QUERY
# interval, decoupled from the now-faster dispatch/evaluation cadence,
# rather than reusing the frontend's unrelated 60-second UI polling interval
# (shared/api/liveStreamsStore.ts's POLL_INTERVAL_MS) or inventing a new
# number.
_SCHEDULE_REFRESH_INTERVAL = timedelta(minutes=15)

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
    stream_schedule = _refresh_and_load_stream_schedule(now=now)

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
        if subscription_record is None and preference.enabled:
            continue
        # A client whose global switch is OFF has normally no push subscription any more
        # (the dashboard toggle deletes it while turning notifications OFF). Such a client
        # still goes through _deliver_if_due below so events that come due while it is OFF
        # are recorded as suppressed -- otherwise turning notifications back ON (which
        # subscribes again) would replay them from the lookback window.
        subscription = subscription_record["value"] if subscription_record is not None else None

        # One bulk read of this client's delivery-log rows for the whole candidate window, instead of one GetItem per
        # (client, event): that per-event read made a run's duration and DynamoDB reads grow with clients x events.
        already_handled = notification_delivery_log_store.delivered_video_ids(
            client_id, [candidate["videoId"] for candidate in candidate_events], now=now
        )
        for candidate in candidate_events:
            checked += 1
            if _deliver_if_due(
                candidate,
                already_handled=already_handled,
                client_id=client_id,
                preference=preference,
                subscription=subscription,
                creators_by_id=creators_by_id,
                now=now,
                vapid_private_key=vapid_private_key,
                vapid_claims=vapid_claims,
            ):
                delivered += 1

        if subscription is None:
            continue  # global OFF and nothing subscribed: there is no reminder to evaluate or send

        for video_id, resolved_reminder in _resolve_reminders_for_client(client_id, stream_schedule).items():
            checked += 1
            if _deliver_reminders_if_due(
                video_id,
                resolved_reminder,
                client_id=client_id,
                preference=preference,
                subscription=subscription,
                creators_by_id=creators_by_id,
                now=now,
                vapid_private_key=vapid_private_key,
                vapid_claims=vapid_claims,
            ):
                delivered += 1

    return {"statusCode": 200, "checked": checked, "delivered": delivered}


def _refresh_and_load_stream_schedule(*, now: datetime) -> dict[str, live_reminder.StreamScheduleEntry]:
    """Return the system-wide "streamSchedule" snapshot's entries, refreshing
    them from the existing Holodex-backed live/upcoming read path ONLY when
    the persisted snapshot's own refreshedAt is stale (_SCHEDULE_REFRESH_INTERVAL)
    -- a 1-minute reminder-evaluation cadence does not mean a 1-minute
    Holodex cadence. One aggregate read_api.get_live_streams() call per
    dispatcher run AT MOST, never per client, never per stream.

    A failed Holodex fetch is NOT treated as "no streams": that would wipe
    every stream's reminder capability (overridden and normal alike) on a
    transient outage. Instead it reuses whatever was last successfully
    persisted, same "degrade the item, never take down the batch" posture
    read_api.py itself documents for Holodex failures.
    """
    existing_record = remote_config_store.get_remote_config(live_reminder.SYSTEM_CLIENT_ID, live_reminder.STREAM_SCHEDULE_KEY)
    existing_snapshot: live_reminder.StreamScheduleSnapshot | None = None
    if existing_record is not None:
        try:
            existing_snapshot = live_reminder.parse_stream_schedule_snapshot(existing_record["value"])
        except live_reminder.ClientError as exc:
            print(f"Warning: stored stream schedule is invalid ({exc}); treating as absent")

    if existing_snapshot is not None and (now - existing_snapshot.refreshed_at) < _SCHEDULE_REFRESH_INTERVAL:
        return existing_snapshot.entries

    try:
        result = read_api.get_live_streams()
    except (HolodexAPIError, HolodexNormalizationError, MissingHolodexApiKeyError) as exc:
        print(f"Warning: Holodex live-stream fetch failed ({exc}); reusing the last persisted stream schedule")
        return existing_snapshot.entries if existing_snapshot is not None else {}

    fresh_entries: dict[str, dict[str, Any]] = {}
    for stream in result["streams"]:
        start_iso = stream["scheduledStart"] or stream["actualStart"]
        if not start_iso:
            continue
        try:
            scheduled_start_ms = int(datetime.fromisoformat(start_iso).timestamp() * 1000)
        except ValueError:
            continue
        topic = classify_video_topic(stream.get("title") or "")
        fresh_entries[stream["videoId"]] = {
            "creatorId": stream["creatorId"],
            "scheduledStartMs": scheduled_start_ms,
            # None (not "other") when no topic matched: such a stream can only
            # get creator 全部 or a stream override.
            "topic": None if topic == OTHER_TOPIC else topic,
        }

    fresh_value = {"entries": fresh_entries, "refreshedAt": now.isoformat()}
    record = remote_config_api.write_remote_config(
        {"clientId": live_reminder.SYSTEM_CLIENT_ID, "key": live_reminder.STREAM_SCHEDULE_KEY, "value": fresh_value}
    )
    remote_config_store.put_remote_config(record)
    return live_reminder.parse_stream_schedule_snapshot(fresh_value).entries


def _resolve_reminders_for_client(
    client_id: str, stream_schedule: dict[str, live_reminder.StreamScheduleEntry]
) -> dict[str, live_reminder.ResolvedReminder]:
    """Every (videoId -> fully-resolved reminder) pair this client has a
    reminder for this run.

    Loads the client's stored reminder items (one remote-config item per
    setting -- see live_reminder.py) and, for each stream in the system-wide
    schedule, resolves the one setting that applies: per-stream override >
    creator 全部 > creator + the stream's topic > unset
    (live_reminder.resolve_effective_setting). A stream with no applicable
    setting is simply absent from the result (unset = no reminder). The
    CURRENT scheduledStartMs always comes from stream_schedule, never from a
    stored setting. A stored item that fails validation is skipped and logged;
    it never affects the client's other settings.
    """
    creator_records = remote_config_store.list_remote_config_by_prefix(client_id, live_reminder.CREATOR_REMINDER_KEY_PREFIX)
    override_records = remote_config_store.list_remote_config_by_prefix(client_id, live_reminder.STREAM_OVERRIDE_KEY_PREFIX)
    settings = live_reminder.parse_reminder_settings(creator_records, override_records)
    for key in settings.invalid_keys:
        print(f"Warning: skipping invalid stored reminder item {key!r} for client {client_id!r}")

    resolved: dict[str, live_reminder.ResolvedReminder] = {}
    for video_id, schedule_entry in stream_schedule.items():
        setting = live_reminder.resolve_effective_setting(
            video_id=video_id, creator_id=schedule_entry.creator_id, topic=schedule_entry.topic, settings=settings
        )
        if setting is None:
            continue
        resolved[video_id] = live_reminder.ResolvedReminder(
            creator_id=schedule_entry.creator_id, scheduled_start_ms=schedule_entry.scheduled_start_ms, setting=setting
        )
    return resolved


def _deliver_if_due(
    candidate: dict[str, Any],
    *,
    already_handled: set[str],
    client_id: str,
    preference: notification_dispatch.NotificationPreference,
    subscription: Any,
    creators_by_id: dict[str, Any],
    now: datetime,
    vapid_private_key: str,
    vapid_claims: dict[str, str],
) -> bool:
    """Send one candidate event to one client if it's due, and record it. Returns whether it was sent.

    The global `enabled` switch is a master OFF: an event that comes due while it
    is OFF is recorded as suppressed (mark_suppressed) and skipped for good, so
    turning notifications back ON later never replays it from the lookback
    window. A creator whose per-creator new-video switch is OFF is treated the
    same way (suppressed, never replayed), while live reminders are untouched. An event whose delivery window has not arrived yet is left alone, so
    it is still sent normally if the switch is back ON by then.
    """
    video_id = candidate["videoId"]
    if video_id in already_handled:
        return False

    discovered_at = datetime.fromisoformat(candidate["discoveredAt"])
    eligible_at = notification_dispatch.next_delivery_window_utc(preference, after=discovered_at)
    if now < eligible_at:
        return False
    if not preference.enabled:
        notification_delivery_log_store.mark_suppressed(client_id, video_id, now.isoformat())
        return False
    if not notification_dispatch.is_new_video_wanted(preference, candidate["creatorId"], content_type=candidate.get("contentType")):
        # The client turned this creator's 新片 switch OFF -- or, for a Short, did not enable this creator in the Short card
        # (the default): like the master switch, an event that comes due while it is OFF is skipped for good, so turning it
        # back ON never replays it from the lookback window.
        notification_delivery_log_store.mark_suppressed(client_id, video_id, now.isoformat())
        return False
    if not notification_dispatch.should_notify_now(preference, candidate["creatorId"], now=now):
        return False

    # Claimed *before* sending (not just recorded after a successful send):
    # this is the atomic gate that stops two overlapping dispatcher runs
    # from both passing the already_delivered() check above and both
    # sending. A lost claim means a concurrent run already owns this
    # (client, video) pair, so this run must not send.
    if not notification_delivery_log_store.mark_delivered(client_id, video_id, now.isoformat()):
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
        notification_delivery_log_store.release_claim(client_id, video_id)
        return False
    if not result.sent:
        print(f"Warning: push send failed for client {client_id!r}, video {video_id!r}: {result.error}")
        notification_delivery_log_store.release_claim(client_id, video_id)
        return False

    notification_delivery_log_store.confirm_delivered(client_id, video_id, now.isoformat())
    return True


def _deliver_reminders_if_due(
    video_id: str,
    override: live_reminder.ResolvedReminder,
    *,
    client_id: str,
    preference: notification_dispatch.NotificationPreference,
    subscription: Any,
    creators_by_id: dict[str, Any],
    now: datetime,
    vapid_private_key: str,
    vapid_claims: dict[str, str],
) -> bool:
    """Send whichever of this stream's start/advance reminders are currently
    due for one client. Both are evaluated independently: a single stream can
    legitimately send both in the same run. Returns whether anything was sent.

    Suppression: the global notifications switch being OFF or a disabled
    creator blocks both (a creator override can never re-enable a client whose
    global switch is OFF); a temporary mute or quiet
    hours block a reminder if they apply EITHER at the moment that reminder
    was meant to fire OR right now -- the reminder is skipped, never delayed
    and never replayed (a late "10 minutes before" is wrong), and nothing is
    recorded for it, so it cannot fire later either. Browser push permission
    does not enter into it: mute is a product-level preference that wins.
    """
    if not notification_dispatch.should_notify_now(preference, override.creator_id, now=now):
        return False

    now_ms = int(now.timestamp() * 1000)
    window_ms = int(_REMINDER_WINDOW.total_seconds() * 1000)
    setting = override.setting
    start_ms = override.scheduled_start_ms
    sent_any = False
    advance_fire_at_ms = live_reminder.advance_reminder_fire_at_ms(setting, start_ms)
    if live_reminder.is_advance_reminder_due(setting, start_ms, now_ms=now_ms, window_ms=window_ms) and not _suppressed_at(
        preference, override.creator_id, advance_fire_at_ms
    ):
        if _send_reminder(
            video_id,
            "advance",
            body=f"Starts in {_ADVANCE_REMINDER_BODY_LABELS[setting.advance_reminder]}",
            client_id=client_id,
            creator_id=override.creator_id,
            creators_by_id=creators_by_id,
            subscription=subscription,
            now=now,
            vapid_private_key=vapid_private_key,
            vapid_claims=vapid_claims,
        ):
            sent_any = True
    if live_reminder.is_start_reminder_due(setting, start_ms, now_ms=now_ms, window_ms=window_ms) and not _suppressed_at(
        preference, override.creator_id, start_ms
    ):
        if _send_reminder(
            video_id,
            "start",
            body=_START_REMINDER_BODY,
            client_id=client_id,
            creator_id=override.creator_id,
            creators_by_id=creators_by_id,
            subscription=subscription,
            now=now,
            vapid_private_key=vapid_private_key,
            vapid_claims=vapid_claims,
        ):
            sent_any = True
    return sent_any


def _suppressed_at(preference: notification_dispatch.NotificationPreference, creator_id: str, instant_ms: int | None) -> bool:
    """Whether a temporary mute or quiet hours applied at the given instant (epoch ms)."""
    if instant_ms is None:
        return False
    instant = datetime.fromtimestamp(instant_ms / 1000, tz=timezone.utc)
    return not notification_dispatch.should_notify_now(preference, creator_id, now=instant)


def _send_reminder(
    video_id: str,
    kind: str,
    *,
    body: str,
    client_id: str,
    creator_id: str,
    creators_by_id: dict[str, Any],
    subscription: Any,
    now: datetime,
    vapid_private_key: str,
    vapid_claims: dict[str, str],
) -> bool:
    """Send one (start or advance) reminder moment, deduped independently of
    every other reminder kind/video pair (spec section 9: clientId + videoId
    + reminder kind) by reusing notification_delivery_log_store's existing
    claimed/delivered state machine against a composite dedupe id, rather
    than a second delivery-history table -- this can never collide with that
    same store's real videoId-only rows (the discovery-notification dedupe
    above), since a real videoId never contains ":reminder:".
    """
    dedupe_id = f"{video_id}:reminder:{kind}"
    if notification_delivery_log_store.already_delivered(client_id, dedupe_id):
        return False
    if not notification_delivery_log_store.mark_delivered(client_id, dedupe_id, now.isoformat()):
        return False

    creator = creators_by_id.get(creator_id)
    name = creator.display_name if creator else "A creator"
    title = f"{name} is live now" if kind == "start" else f"{name} is starting soon"
    result = push_sender.send_push_notification(
        subscription,
        title=title,
        body=body,
        data={"videoId": video_id, "reminderKind": kind},
        vapid_private_key=vapid_private_key,
        vapid_claims=vapid_claims,
    )
    if result.subscription_expired:
        print(f"Push subscription expired for client {client_id!r}; leaving cleanup to a future pass")
        notification_delivery_log_store.release_claim(client_id, dedupe_id)
        return False
    if not result.sent:
        print(f"Warning: reminder push send failed for client {client_id!r}, video {video_id!r} ({kind}): {result.error}")
        notification_delivery_log_store.release_claim(client_id, dedupe_id)
        return False

    notification_delivery_log_store.confirm_delivered(client_id, dedupe_id, now.isoformat())
    return True


def _recent_events(now: datetime) -> list[dict[str, Any]]:
    """Every notification event from the last _EVENT_LOOKBACK_DAYS calendar days, in _EVENT_TIMEZONE."""
    local_today = now.astimezone(_EVENT_TIMEZONE).date()
    events: list[dict[str, Any]] = []
    for day_offset in range(_EVENT_LOOKBACK_DAYS):
        event_date = (local_today - timedelta(days=day_offset)).isoformat()
        events.extend(notification_events_store.list_events_for_date(event_date))
    return events
