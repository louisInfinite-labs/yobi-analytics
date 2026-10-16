"""Scheduled Lambda entry point for the notification dispatcher: live reminders every minute, plus the `new_video_slots` mode.

One Lambda, two schedules (terraform/eventbridge.tf):

- no `mode` (rate(1 minute)): the live reminders below. This path no longer delivers new-video pushes.
- `{"mode": "new_video_slots"}` (every 15 minutes, UTC :00/:15/:30/:45): scheduled new-video delivery, implemented in
  new_video_dispatcher.py. It is routed there before any reminder work, so the two never share a run.

Each reminder run:

1. Loads every client that has a stored NotificationPreference (Roadmap 4.6's opaque value, under remote_config_store.py's
   generic store).
2. A client with a stored preference but no stored push subscription is skipped entirely (nothing to deliver to), not
   treated as an error -- Roadmap 4.5/4.6 don't require subscribing to push before holding a preference.

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
-- rate(1 minute), applied to production since 2026-10-10, so _REMINDER_WINDOW
matches it and "at start"/"1min"/"10min" are honoured precisely, not just
"30min"/"1hour". It is the ONE shared timer for every subscriber: no per-user
or per-stream scheduler exists, and none is needed -- every run just compares
the clock with the stored schedule.

A stream's START reminder (開播時通知) is due when its stored scheduledStart
arrives, nothing else: no Holodex request is made at that minute and no
Holodex/YouTube confirmation that the stream is live is awaited (see
live_reminder.is_start_reminder_due); the pre-start reminders (1/10/30/60
minutes) work the same way from the same stored start. A reschedule or
cancellation Holodex has reported is picked up as soon as the shared snapshot
carries it; one it has NOT reported yet cannot be known here -- the shared
snapshot is refreshed every 10 minutes (tracking/livestream_lifecycle.py), so
that is an inherent freshness limit of the data source, not of this timer.

Reminder EVALUATION (every dispatcher run) is deliberately decoupled from
how often Holodex is actually QUERIED: this module never queries Holodex.
_refresh_and_load_stream_schedule re-derives its "streamSchedule" entries from
read_api.get_live_streams() -- a read of the shared snapshot, which only the
10-minute display job refreshes from Holodex -- exactly when that snapshot is
newer than the one the stored entries were derived from (a tiny heartbeat read
per run, see live_reminder's streamSchedule note). One derivation per dispatcher
run at most, never per client, never per stream.

The "streamSchedule" snapshot is a full-replace write each derivation
(never merged), so a stream Holodex no longer returns (ended, cancelled, or
beyond its own upcoming window) naturally ages out on the next one --
no separate expiry/TTL bookkeeping needed. A failed derivation leaves the
previously stored snapshot untouched rather than wiping it (see
_refresh_and_load_stream_schedule), so a transient outage degrades to
"slightly stale schedule data", never "no reminders at all".
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from stores import notification_delivery_log_store
from notifications import notification_dispatch
from notifications import live_reminder
from notifications import new_video_dispatcher
from notifications import notification_text
from notifications import push_sender
from stores import remote_config_store
from api import remote_config_api
from api import read_api
from api.holodex_client import HolodexAPIError
from api.holodex_normalization import HolodexNormalizationError
from ops.config import get_vapid_credentials, MissingHolodexApiKeyError
from tracking import livestream_lifecycle
from tracking.creator_master import load_creators
from tracking.video_topics import OTHER_TOPIC, classify_video_topic

_NOTIFICATION_PREFERENCE_KEY = "notificationPreference"
_PUSH_SUBSCRIPTION_KEY = "pushSubscription"

# Matches this Lambda's own EventBridge rate (terraform/eventbridge.tf,
# rate(1 minute)) -- a reminder's fire window is
# [fire_at, fire_at + this), so it's always caught by the next run rather
# than skipped between two polls, while staying tight enough to honour
# "1min"/"10min" at their configured offset rather than merely eventually.
_REMINDER_WINDOW = timedelta(minutes=1)

# How long a LEGACY delivery row (keyed without a scheduled start, written by the previous version) still counts as "already sent for this start".
# A few reminder windows: it only has to cover the minutes around a redeploy; older rows belong to a start the stream may have moved away from.
_LEGACY_DEDUPE_WINDOW = timedelta(minutes=10)

# FALLBACK only: how old the persisted "streamSchedule" entries may get before this run re-derives them when the shared snapshot's own
# freshness cannot be read (a store hiccup, a non-DynamoDB environment). Normally the entries are re-derived exactly when the shared snapshot is
# newer than the one they came from, so this never decides anything. Equal to the display job's 10-minute cadence
# (tracking.livestream_lifecycle.DISPLAY_REFRESH_INTERVAL_SECONDS): re-deriving more often than the snapshot changes would find nothing new, and
# less often would let a start time lag the snapshot it should follow.
_SCHEDULE_REFRESH_INTERVAL = timedelta(minutes=10)


class UnsupportedModeError(ValueError):
    """An event's explicit `mode` this Lambda does not know -- a stale or mistyped schedule target must fail loudly, never
    silently run the reminder job instead."""


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Run the new-video slot delivery (`mode: new_video_slots`), or else deliver every due live reminder."""
    mode = (event or {}).get("mode")
    if mode == new_video_dispatcher.MODE:
        return new_video_dispatcher.run(event, context)
    if mode is not None:
        raise UnsupportedModeError(f"Unsupported mode {mode!r}; expected {new_video_dispatcher.MODE!r} or omitted")

    now = datetime.now(timezone.utc)
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
        if subscription_record is None:
            continue  # nothing to send a reminder to (a client whose global switch is OFF has its subscription removed)
        subscription = subscription_record["value"]

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


def _read_source_refreshed_at() -> datetime | None:
    """When the shared live/upcoming snapshot was last refreshed (livestream_lifecycle.read_display_refreshed_at -- one tiny heartbeat read), or None
    when that cannot be known: nothing persisted yet, or the store failed. A failure here must never stop reminders, so it only means "unknown",
    and the caller falls back to the time-based rule."""
    try:
        return livestream_lifecycle.read_display_refreshed_at()
    except Exception as exc:  # noqa: BLE001 -- a freshness hint; every failure mode degrades to the interval rule
        print(f"Warning: could not read the live snapshot's freshness ({type(exc).__name__}): {exc}; using the time-based schedule refresh")
        return None


def _stream_schedule_is_current(
    existing: live_reminder.StreamScheduleSnapshot, source_refreshed_at: datetime | None, *, now: datetime
) -> bool:
    """Whether the stored entries still reflect the shared snapshot, so this run can reuse them without re-deriving.

    With the snapshot's freshness known: current exactly when the entries were derived from that very refresh or a later one (a record written
    before the source was tracked is re-derived once). Unknown: the time-based fallback, _SCHEDULE_REFRESH_INTERVAL since the last derivation.
    """
    if source_refreshed_at is None:
        return (now - existing.refreshed_at) < _SCHEDULE_REFRESH_INTERVAL
    if existing.source_refreshed_at is None:
        return False
    return existing.source_refreshed_at >= source_refreshed_at


def _refresh_and_load_stream_schedule(*, now: datetime) -> dict[str, live_reminder.StreamScheduleEntry]:
    """Return the system-wide "streamSchedule" snapshot's entries, re-deriving
    them from the existing live/upcoming read path (read_api.get_live_streams,
    which reads the SHARED snapshot -- never Holodex) ONLY when that shared
    snapshot is newer than the one the stored entries came from -- a
    1-minute reminder-evaluation cadence does not mean a 1-minute derivation,
    let alone a 1-minute Holodex cadence. One get_live_streams() call per
    dispatcher run AT MOST, never per client, never per stream.

    A failed read is NOT treated as "no streams": that would wipe
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

    # Read BEFORE deriving: if the shared snapshot is refreshed while this run derives, the entries are recorded as coming from the OLDER one
    # and the next run re-derives -- never the reverse (claiming newer data than was actually read).
    source_refreshed_at = _read_source_refreshed_at()
    if existing_snapshot is not None and _stream_schedule_is_current(existing_snapshot, source_refreshed_at, now=now):
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
        if isinstance(stream.get("title"), str) and stream["title"].strip():
            fresh_entries[stream["videoId"]]["title"] = stream["title"]  # the original title, shown as the notification body

    fresh_value: dict[str, Any] = {"entries": fresh_entries, "refreshedAt": now.isoformat()}
    if source_refreshed_at is not None:
        fresh_value["sourceRefreshedAt"] = source_refreshed_at.isoformat()
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
            creator_id=schedule_entry.creator_id,
            scheduled_start_ms=schedule_entry.scheduled_start_ms,
            setting=setting,
            stream_title=schedule_entry.title,
        )
    return resolved


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
            notification_text.KIND_ADVANCE,
            scheduled_start_ms=start_ms,
            advance=setting.advance_reminder,
            stream_title=override.stream_title,
            locale=preference.locale,
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
            notification_text.KIND_START,
            scheduled_start_ms=start_ms,
            advance=None,
            stream_title=override.stream_title,
            locale=preference.locale,
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


def _reminder_dedupe_ids(video_id: str, kind: str, scheduled_start_ms: int) -> tuple[str, str]:
    """(the id one reminder TARGET is deduped under, the legacy id older deployments used).

    A target is a reminder kind for one specific scheduled start, to the MINUTE (the dispatcher's own resolution, so a few seconds of jitter in a
    reported start can never mint a new target): a stream rescheduled to another time is a NEW target, so a delivery made for the superseded time
    neither blocks the new one nor can ever fire again (the old start is never due once the stored schedule has moved), while retries, overlapping
    runs and a redeploy of the SAME target still collapse into one delivery. The legacy id (no start time) is honoured only while its row is
    fresh (_LEGACY_DEDUPE_WINDOW): that is exactly "an older version just sent this for the current start" -- the redeploy minute -- and never a
    stale row that would wrongly block a reschedule.
    """
    legacy_id = f"{video_id}:reminder:{kind}"
    return f"{legacy_id}@{scheduled_start_ms // 60_000}", legacy_id


def _send_reminder(
    video_id: str,
    kind: str,
    *,
    scheduled_start_ms: int,
    advance: str | None,
    stream_title: str | None,
    locale: str,
    client_id: str,
    creator_id: str,
    creators_by_id: dict[str, Any],
    subscription: Any,
    now: datetime,
    vapid_private_key: str,
    vapid_claims: dict[str, str],
) -> bool:
    """Send one (start or advance) reminder moment, deduped independently of
    every other reminder kind/video/target (spec section 9: clientId + videoId
    + reminder kind, here also the scheduled start the reminder is for -- see
    _reminder_dedupe_ids) by reusing notification_delivery_log_store's existing
    claimed/delivered state machine against a composite dedupe id, rather
    than a second delivery-history table -- this can never collide with that
    same store's real videoId-only rows (the discovery-notification dedupe
    above), since a real videoId never contains ":reminder:".

    The claim is an atomic conditional write made BEFORE the push is sent, so
    two overlapping dispatcher runs (or an EventBridge retry) can never both
    send; a send that fails releases the claim so a retry inside the reminder
    window can still deliver, and a confirmed delivery is permanent.
    """
    dedupe_id, legacy_id = _reminder_dedupe_ids(video_id, kind, scheduled_start_ms)
    if notification_delivery_log_store.handled_within(client_id, legacy_id, _LEGACY_DEDUPE_WINDOW, now=now):
        return False
    if notification_delivery_log_store.already_delivered(client_id, dedupe_id):
        return False
    if not notification_delivery_log_store.mark_delivered(client_id, dedupe_id, now.isoformat()):
        return False

    creator = creators_by_id.get(creator_id)
    text = notification_text.reminder_notification(
        locale=locale,
        kind=kind,
        advance=advance,
        creator_name=creator.display_name if creator else None,
        stream_title=stream_title,
    )
    result = push_sender.send_push_notification(
        subscription,
        title=text.title,
        body=text.body,
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
