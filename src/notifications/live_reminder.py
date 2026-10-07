"""Per-creator recurring live-reminder timing and per-stream single-stream
overrides (Dashboard spec: "Schedule single-stream notification override"),
layered on the same remote-config/notification-preference architecture as
notification_dispatch.py (Roadmap 4.6) rather than a second notification
service.

Three sibling (clientId, key) remote-config records, read by the same
notification_dispatcher.py poll that already resolves NotificationPreference:

    "creatorLiveReminders"         -- per client, creatorId -> LiveReminderSetting
    "streamNotificationOverrides"  -- per client, videoId   -> StreamReminderOverride
                                       (notification preference only -- NOT a frozen
                                       copy of the stream's own schedule)
    "streamSchedule"               -- NOT per client (stored under SYSTEM_CLIENT_ID),
                                       {entries: videoId -> StreamScheduleEntry,
                                       refreshedAt} -- the SOLE source of
                                       scheduledStartMs at dispatch time, for
                                       overridden and non-overridden streams alike,
                                       so a reschedule is always picked up and a
                                       creator's recurring reminder can resolve a
                                       normal, never-overridden stream without any
                                       client's browser ever having been open.
                                       refreshedAt backs the staleness check that
                                       decouples how often reminders are EVALUATED
                                       (every dispatcher run) from how often Holodex
                                       is actually QUERIED (see
                                       notification_dispatcher.py's
                                       _SCHEDULE_REFRESH_INTERVAL) -- never per
                                       client, never per stream, one aggregate
                                       refresh per dispatcher run at most.

Kept as separate keys from "notificationPreference" deliberately: that
record is always a full-overwrite write (remote_config_store.put_remote_config's
own contract) from NotificationToggle's on/off sync, which has no field for
either of these -- folding them into the same blob would make every plain
notification on/off toggle silently wipe out a saved reminder configuration.

Reminder-time values mirror the Dashboard's own
notificationTopics.ts/REMINDER_TIME_VALUES exactly -- no second list, no new
values. "at_start" is represented here as advance_reminder=None (no extra
reminder); every other value is an ADDITIONAL pre-start reminder. notify_at_start
and advance_reminder are independent, both-can-apply dimensions (spec section 1):
a stream can legitimately get both an advance reminder and a start reminder,
never a choice between them.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

CREATOR_LIVE_REMINDERS_KEY = "creatorLiveReminders"
STREAM_NOTIFICATION_OVERRIDES_KEY = "streamNotificationOverrides"

# A third sibling remote-config record, NOT scoped to any one client --
# stored under this fixed sentinel clientId in the same generic
# (clientId, configKey) -> value table everything else in this module uses,
# rather than a new DynamoDB table. Refreshed every dispatcher run from the
# existing Holodex-backed live/upcoming read path (read_api.get_live_streams,
# the same data GET /live-streams already serves the Dashboard), so a
# creator's recurring reminder can resolve scheduledStartMs for a normal
# stream nobody ever opened Schedule for -- see notification_dispatcher.py's
# _refresh_and_load_stream_schedule.
STREAM_SCHEDULE_KEY = "streamSchedule"
SYSTEM_CLIENT_ID = "__system__"

# Mirrors frontend/dashboard/src/features/notifications/model/notificationTopics.ts's
# REMINDER_TIME_VALUES minus "at_start" (represented here as advance_reminder=None,
# never as a stored string) -- do not add a value here without adding it there too.
ADVANCE_REMINDER_OFFSET_MINUTES: dict[str, int] = {"1min": 1, "10min": 10, "30min": 30, "1hour": 60}


class ClientError(ValueError):
    """A clean, safe-to-surface 4xx error for a malformed live-reminder value.

    Mirrors notification_dispatch.ClientError/remote_config_api.ClientError.
    """


@dataclass(frozen=True)
class LiveReminderSetting:
    """One creator's recurring reminder config, or one stream override's --
    the identical shape either way (spec section 4: an override must contain
    the same relevant fields as the creator setting it replaces)."""

    notify_at_start: bool
    advance_reminder: str | None  # one of ADVANCE_REMINDER_OFFSET_MINUTES, or None


DEFAULT_LIVE_REMINDER_SETTING = LiveReminderSetting(notify_at_start=True, advance_reminder=None)


@dataclass(frozen=True)
class StreamReminderOverride:
    """One single-stream override: notification preference only, never a
    frozen copy of the stream's own schedule. A livestream can be
    rescheduled after an override is saved -- the override does NOT carry
    its own scheduledStartMs; dispatch time always resolves the CURRENT
    scheduledStartMs from the system-wide streamSchedule snapshot, for both
    overridden and non-overridden streams alike (see
    notification_dispatcher.py's _relevant_reminders_for_client)."""

    creator_id: str
    setting: LiveReminderSetting


@dataclass(frozen=True)
class StreamScheduleEntry:
    """One stream's identity/timing in the system-wide schedule snapshot --
    just enough for the dispatcher to resolve a normal (non-overridden)
    stream's reminder: which creator it belongs to and when it starts. The
    SOLE source of scheduledStartMs at dispatch time, for overridden streams
    too -- see StreamReminderOverride's own docstring."""

    creator_id: str
    scheduled_start_ms: int


@dataclass(frozen=True)
class StreamScheduleSnapshot:
    """The persisted "streamSchedule" record's full parsed shape: the
    schedule entries themselves, plus when they were last successfully
    refreshed from Holodex -- the staleness check that decouples 1-minute
    reminder evaluation from how often Holodex is actually queried (see
    notification_dispatcher.py's _SCHEDULE_REFRESH_INTERVAL)."""

    entries: dict[str, StreamScheduleEntry]
    refreshed_at: datetime


@dataclass(frozen=True)
class ResolvedReminder:
    """One (videoId, client) pair's fully-resolved, ready-to-dispatch
    reminder: the CURRENT scheduledStartMs (always from StreamScheduleEntry,
    never from a stored override) plus whichever LiveReminderSetting won
    (stream override, else creator recurring, see resolve_effective_setting)."""

    creator_id: str
    scheduled_start_ms: int
    setting: LiveReminderSetting


def _parse_live_reminder_setting(raw: Any, *, context: str) -> LiveReminderSetting:
    if not isinstance(raw, dict):
        raise ClientError(f"{context} must be an object")
    notify_at_start = raw.get("notifyAtStart")
    if not isinstance(notify_at_start, bool):
        raise ClientError(f"{context}.notifyAtStart is required and must be a boolean, got {notify_at_start!r}")
    advance_reminder = raw.get("advanceReminder")
    if advance_reminder is not None and advance_reminder not in ADVANCE_REMINDER_OFFSET_MINUTES:
        raise ClientError(
            f"{context}.advanceReminder must be one of {sorted(ADVANCE_REMINDER_OFFSET_MINUTES)} or null, got {advance_reminder!r}"
        )
    return LiveReminderSetting(notify_at_start=notify_at_start, advance_reminder=advance_reminder)


def parse_creator_live_reminders(raw: Any) -> dict[str, LiveReminderSetting]:
    """Validate a stored/incoming "creatorLiveReminders" value: creatorId -> LiveReminderSetting."""
    if not isinstance(raw, dict):
        raise ClientError("creatorLiveReminders must be an object mapping creatorId to a reminder setting")
    result: dict[str, LiveReminderSetting] = {}
    for creator_id, value in raw.items():
        if not isinstance(creator_id, str) or not creator_id:
            raise ClientError(f"creatorLiveReminders keys must be non-empty creatorId strings, got {creator_id!r}")
        result[creator_id] = _parse_live_reminder_setting(value, context=f"creatorLiveReminders[{creator_id!r}]")
    return result


def parse_stream_notification_overrides(raw: Any) -> dict[str, StreamReminderOverride]:
    """Validate a stored/incoming "streamNotificationOverrides" value: videoId -> StreamReminderOverride.

    Deliberately has no scheduledStartMs field (see StreamReminderOverride's
    own docstring) -- a stored override predating this change may still
    carry a stray "scheduledStartMs" key; it's simply ignored, not rejected,
    so an old record doesn't suddenly fail to parse.
    """
    if not isinstance(raw, dict):
        raise ClientError("streamNotificationOverrides must be an object mapping videoId to an override")
    result: dict[str, StreamReminderOverride] = {}
    for video_id, value in raw.items():
        if not isinstance(video_id, str) or not video_id:
            raise ClientError(f"streamNotificationOverrides keys must be non-empty videoId strings, got {video_id!r}")
        if not isinstance(value, dict):
            raise ClientError(f"streamNotificationOverrides[{video_id!r}] must be an object")
        creator_id = value.get("creatorId")
        if not isinstance(creator_id, str) or not creator_id:
            raise ClientError(f"streamNotificationOverrides[{video_id!r}].creatorId is required and must be a non-empty string")
        setting = _parse_live_reminder_setting(value, context=f"streamNotificationOverrides[{video_id!r}]")
        result[video_id] = StreamReminderOverride(creator_id=creator_id, setting=setting)
    return result


def _parse_schedule_entries(raw: Any) -> dict[str, StreamScheduleEntry]:
    if not isinstance(raw, dict):
        raise ClientError("streamSchedule entries must be an object mapping videoId to a schedule entry")
    result: dict[str, StreamScheduleEntry] = {}
    for video_id, value in raw.items():
        if not isinstance(video_id, str) or not video_id:
            raise ClientError(f"streamSchedule keys must be non-empty videoId strings, got {video_id!r}")
        if not isinstance(value, dict):
            raise ClientError(f"streamSchedule[{video_id!r}] must be an object")
        creator_id = value.get("creatorId")
        if not isinstance(creator_id, str) or not creator_id:
            raise ClientError(f"streamSchedule[{video_id!r}].creatorId is required and must be a non-empty string")
        scheduled_start_ms = value.get("scheduledStartMs")
        if not isinstance(scheduled_start_ms, int) or isinstance(scheduled_start_ms, bool):
            raise ClientError(f"streamSchedule[{video_id!r}].scheduledStartMs is required and must be an integer (epoch ms)")
        result[video_id] = StreamScheduleEntry(creator_id=creator_id, scheduled_start_ms=scheduled_start_ms)
    return result


def parse_stream_schedule_snapshot(raw: Any) -> StreamScheduleSnapshot:
    """Validate a stored/incoming "streamSchedule" value: {entries, refreshedAt}.

    refreshedAt is when this snapshot was last successfully refreshed from
    Holodex (notification_dispatcher.py's _refresh_and_load_stream_schedule)
    -- what the staleness check compares against, independent of how often
    the dispatcher itself is invoked.
    """
    if not isinstance(raw, dict):
        raise ClientError("streamSchedule must be an object with 'entries' and 'refreshedAt'")
    entries = _parse_schedule_entries(raw.get("entries", {}))
    refreshed_at_raw = raw.get("refreshedAt")
    if not isinstance(refreshed_at_raw, str) or not refreshed_at_raw:
        raise ClientError("streamSchedule.refreshedAt is required and must be an ISO 8601 timestamp string")
    try:
        refreshed_at = datetime.fromisoformat(refreshed_at_raw)
    except ValueError:
        raise ClientError(f"streamSchedule.refreshedAt is not a valid ISO 8601 timestamp: {refreshed_at_raw!r}") from None
    if refreshed_at.tzinfo is None:
        # The dispatcher compares this against a timezone-aware "now"; a naive
        # value would raise TypeError there and fail every dispatcher run.
        raise ClientError(f"streamSchedule.refreshedAt must include a UTC offset: {refreshed_at_raw!r}")
    return StreamScheduleSnapshot(entries=entries, refreshed_at=refreshed_at)


def resolve_effective_setting(
    *,
    video_id: str,
    creator_id: str,
    stream_overrides: dict[str, StreamReminderOverride],
    creator_reminders: dict[str, LiveReminderSetting],
    default: LiveReminderSetting = DEFAULT_LIVE_REMINDER_SETTING,
) -> LiveReminderSetting:
    """Stream override > creator recurring setting > default (spec section 4).

    A present override REPLACES the creator's recurring setting wholesale --
    it is never merged with it (e.g. creator 30min + override 1hour must
    resolve to exactly 1hour, not "1hour and 30min and start").
    """
    override = stream_overrides.get(video_id)
    if override is not None:
        return override.setting
    return creator_reminders.get(creator_id, default)


def is_advance_reminder_due(setting: LiveReminderSetting, scheduled_start_ms: int, *, now_ms: int, window_ms: int) -> bool:
    """Whether the advance (pre-start) reminder's fire window currently contains now_ms.

    window_ms must be at least the dispatcher's own poll interval so a
    reminder is never skipped between two runs (see notification_dispatcher's
    _REMINDER_WINDOW) -- this makes the fire window [fire_at, fire_at +
    window_ms), never earlier than the configured offset, possibly up to
    window_ms late.
    """
    if setting.advance_reminder is None:
        return False
    offset_ms = ADVANCE_REMINDER_OFFSET_MINUTES[setting.advance_reminder] * 60_000
    fire_at = scheduled_start_ms - offset_ms
    return fire_at <= now_ms < fire_at + window_ms


def is_start_reminder_due(setting: LiveReminderSetting, scheduled_start_ms: int, *, now_ms: int, window_ms: int) -> bool:
    """Whether the start reminder's fire window currently contains now_ms.

    Uses the stream's own scheduledStartMs, not any discovery timestamp --
    section 7/item H of the single-stream override spec requires this
    explicitly, since discoveredAt (notification_events_store.py) can be
    recorded well before or independent of a stream's actual scheduled
    start time.
    """
    if not setting.notify_at_start:
        return False
    return scheduled_start_ms <= now_ms < scheduled_start_ms + window_ms
