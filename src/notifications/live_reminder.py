"""Live-reminder settings and the effective-reminder resolver, layered on the
same remote-config/notification-preference architecture as
notification_dispatch.py (Roadmap 4.6) rather than a second notification
service.

Every reminder setting is its OWN (clientId, configKey) remote-config item,
never a field of a shared map -- so changing one setting is a single-item
write that cannot read, rewrite or overwrite any other setting, and two
devices changing different settings can never clobber each other:

    "creatorReminder#<creatorId>#all"        -- creator-level 全部 reminder
    "creatorReminder#<creatorId>#<topicId>"  -- creator + topic reminder
                                                 (<topicId> is a canonical
                                                 tracking.video_topics id)
    "streamOverride#<videoId>"               -- one exact stream's override
                                                 (set from Schedule/Timeline)

An item's value is a LiveReminderSetting ({notifyAtStart, advanceReminder});
a stream override additionally carries the stream's creatorId. "Unset" is
the item being ABSENT -- there is no stored "unset" value, and an unset
setting never falls back to any default reminder.

Plus one system-wide record, NOT scoped to any one client (stored under
SYSTEM_CLIENT_ID):

    "streamSchedule"  -- {entries: videoId -> StreamScheduleEntry, refreshedAt}
                         -- the SOLE source of scheduledStartMs (and of a
                         stream's topic) at dispatch time. refreshedAt backs
                         the staleness check that decouples how often
                         reminders are EVALUATED (every dispatcher run) from
                         how often Holodex is actually QUERIED (see
                         notification_dispatcher.py's _SCHEDULE_REFRESH_INTERVAL).

Precedence, highest first (the first two live outside this module, in
notification_dispatch.should_notify_now / the dispatcher):

    1. Mute / Quiet Hours (also creator disabled) -- suppress, never delay
    2. per-stream override    -- applies to that exact stream only
    3. creator 全部           -- shadows every topic of that creator
    4. creator + matched topic
    5. unset                  -- no reminder

Shadowing happens ONLY here, at resolve time: setting creator 全部 never
touches a topic item, and unsetting it makes the topic items take effect
again exactly as they were.

Kept as separate keys from "notificationPreference" deliberately (mute, quiet
hours and the on/off switch live there).

Reminder-time values mirror the Dashboard's own
notificationTopics.ts/REMINDER_TIME_VALUES exactly -- no second list, no new
values. "at_start" is represented here as advance_reminder=None (no extra
reminder); every other value is an ADDITIONAL pre-start reminder. notify_at_start
and advance_reminder are independent, both-can-apply dimensions: a stream can
legitimately get both an advance reminder and a start reminder.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from tracking.video_topics import OTHER_TOPIC, TOPIC_IDS

CREATOR_REMINDER_KEY_PREFIX = "creatorReminder#"
STREAM_OVERRIDE_KEY_PREFIX = "streamOverride#"
KEY_SEPARATOR = "#"

# The creator-level scope. NOT a video topic: it is never returned by the
# title classifier and is not in tracking.video_topics.TOPIC_IDS.
ALL_TOPICS_SCOPE = "all"

# The canonical topics a creator + topic reminder can target: every
# classifier topic except the "nothing matched" fallback, which names no
# game/genre a user could pick (a stream classified "other" is simply
# topic-less: only creator 全部 or a stream override can apply to it).
REMINDER_TOPIC_IDS = frozenset(TOPIC_IDS - {OTHER_TOPIC})

# A system-wide remote-config record, NOT scoped to any one client -- stored
# under this fixed sentinel clientId in the same generic
# (clientId, configKey) -> value table everything else in this module uses,
# rather than a new DynamoDB table. Refreshed every dispatcher run from the
# existing Holodex-backed live/upcoming read path (read_api.get_live_streams,
# the same data GET /live-streams already serves the Dashboard) -- see
# notification_dispatcher.py's _refresh_and_load_stream_schedule.
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
    """One reminder setting -- the identical shape at every level (creator
    全部, creator + topic, and a single stream's override)."""

    notify_at_start: bool
    advance_reminder: str | None  # one of ADVANCE_REMINDER_OFFSET_MINUTES, or None


@dataclass(frozen=True)
class StreamReminderOverride:
    """One single-stream override: notification preference only, never a
    frozen copy of the stream's own schedule. A livestream can be
    rescheduled after an override is saved -- the override does NOT carry
    its own scheduledStartMs; dispatch time always resolves the CURRENT
    scheduledStartMs from the system-wide streamSchedule snapshot."""

    creator_id: str
    setting: LiveReminderSetting


@dataclass(frozen=True)
class StreamScheduleEntry:
    """One stream's identity/timing in the system-wide schedule snapshot --
    just enough for the dispatcher to resolve its reminder: which creator it
    belongs to, when it starts, and its canonical topic (None when the title
    classifier matched no topic). The SOLE source of scheduledStartMs."""

    creator_id: str
    scheduled_start_ms: int
    topic: str | None = None


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
    (see resolve_effective_setting)."""

    creator_id: str
    scheduled_start_ms: int
    setting: LiveReminderSetting


@dataclass(frozen=True)
class ReminderSettings:
    """Every reminder setting one client has stored, parsed. `invalid_keys`
    names stored items that failed validation and were skipped -- one bad
    item degrades only itself, never the client's other settings."""

    creator_all: dict[str, LiveReminderSetting] = field(default_factory=dict)
    creator_topics: dict[tuple[str, str], LiveReminderSetting] = field(default_factory=dict)
    stream_overrides: dict[str, StreamReminderOverride] = field(default_factory=dict)
    invalid_keys: tuple[str, ...] = ()


def parse_key_part(raw: Any, *, name: str) -> str:
    """Validate one component of a reminder config key: a non-empty string
    that cannot contain the key separator (it would make the key ambiguous)."""
    if not isinstance(raw, str) or not raw:
        raise ClientError(f"{name} is required and must be a non-empty string")
    if KEY_SEPARATOR in raw:
        raise ClientError(f"{name} must not contain {KEY_SEPARATOR!r}, got {raw!r}")
    return raw


def parse_reminder_scope(raw: Any) -> str:
    """Validate a reminder scope: "all" (creator-level 全部) or a canonical
    video topic id (REMINDER_TOPIC_IDS) -- the same machine id
    the frontend and GET /topics use. A topic the backend doesn't classify
    is rejected: it cannot match any stream, so a stored item would be dead."""
    if raw == ALL_TOPICS_SCOPE or (isinstance(raw, str) and raw in REMINDER_TOPIC_IDS):
        return raw
    raise ClientError(f"scope must be {ALL_TOPICS_SCOPE!r} or one of {sorted(REMINDER_TOPIC_IDS)}, got {raw!r}")


def creator_reminder_key(creator_id: str, scope: str) -> str:
    """The config key of one creator-level (scope "all") or creator + topic reminder item."""
    creator_id = parse_key_part(creator_id, name="creatorId")
    scope = parse_reminder_scope(scope)
    return f"{CREATOR_REMINDER_KEY_PREFIX}{creator_id}{KEY_SEPARATOR}{scope}"


def stream_override_key(video_id: str) -> str:
    """The config key of one stream's override item."""
    return f"{STREAM_OVERRIDE_KEY_PREFIX}{parse_key_part(video_id, name='videoId')}"


def parse_live_reminder_setting(raw: Any, *, context: str = "reminder setting") -> LiveReminderSetting:
    """Validate an incoming/stored LiveReminderSetting value."""
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


def parse_stream_override(raw: Any, *, context: str = "stream override") -> StreamReminderOverride:
    """Validate an incoming/stored stream override: a reminder setting plus the stream's creatorId."""
    if not isinstance(raw, dict):
        raise ClientError(f"{context} must be an object")
    creator_id = raw.get("creatorId")
    if not isinstance(creator_id, str) or not creator_id:
        raise ClientError(f"{context}.creatorId is required and must be a non-empty string")
    return StreamReminderOverride(creator_id=creator_id, setting=parse_live_reminder_setting(raw, context=context))


def parse_reminder_settings(
    creator_reminder_records: list[dict[str, Any]], stream_override_records: list[dict[str, Any]]
) -> ReminderSettings:
    """Parse one client's stored reminder items (records as returned by
    remote_config_store: {clientId, key, value, updatedAt}) into
    ReminderSettings. An item whose key or value is malformed is skipped and
    reported in `invalid_keys`; it never affects any other item."""
    creator_all: dict[str, LiveReminderSetting] = {}
    creator_topics: dict[tuple[str, str], LiveReminderSetting] = {}
    stream_overrides: dict[str, StreamReminderOverride] = {}
    invalid: list[str] = []

    for record in creator_reminder_records:
        key = record["key"]
        try:
            parts = key.split(KEY_SEPARATOR)
            if len(parts) != 3 or parts[0] + KEY_SEPARATOR != CREATOR_REMINDER_KEY_PREFIX:
                raise ClientError(f"malformed creator reminder key {key!r}")
            creator_id = parse_key_part(parts[1], name="creatorId")
            scope = parse_reminder_scope(parts[2])
            setting = parse_live_reminder_setting(record["value"], context=key)
        except ClientError:
            invalid.append(key)
            continue
        if scope == ALL_TOPICS_SCOPE:
            creator_all[creator_id] = setting
        else:
            creator_topics[(creator_id, scope)] = setting

    for record in stream_override_records:
        key = record["key"]
        try:
            if not key.startswith(STREAM_OVERRIDE_KEY_PREFIX):
                raise ClientError(f"malformed stream override key {key!r}")
            video_id = parse_key_part(key[len(STREAM_OVERRIDE_KEY_PREFIX) :], name="videoId")
            stream_overrides[video_id] = parse_stream_override(record["value"], context=key)
        except ClientError:
            invalid.append(key)

    return ReminderSettings(
        creator_all=creator_all,
        creator_topics=creator_topics,
        stream_overrides=stream_overrides,
        invalid_keys=tuple(invalid),
    )


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
        # Optional: a snapshot written before topics were tracked has none.
        topic = value.get("topic")
        if topic is not None and (not isinstance(topic, str) or topic not in REMINDER_TOPIC_IDS):
            raise ClientError(f"streamSchedule[{video_id!r}].topic must be one of {sorted(REMINDER_TOPIC_IDS)} or null, got {topic!r}")
        result[video_id] = StreamScheduleEntry(creator_id=creator_id, scheduled_start_ms=scheduled_start_ms, topic=topic)
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
    *, video_id: str, creator_id: str, topic: str | None, settings: ReminderSettings
) -> LiveReminderSetting | None:
    """The one reminder setting that applies to this stream, or None for "no reminder".

    Per-stream override > creator 全部 > creator + matched topic > unset.
    The winning setting REPLACES the others wholesale -- it is never merged
    with them (e.g. 全部 30min + topic 10min resolves to exactly 30min). The
    shadowed settings are only skipped here, never modified: unsetting 全部
    makes the topic setting win again. `topic` is the stream's canonical
    topic id, or None when the classifier matched none (only 全部 or an
    override can then apply). Unset never falls back to a default.
    """
    override = settings.stream_overrides.get(video_id)
    if override is not None:
        return override.setting
    creator_all = settings.creator_all.get(creator_id)
    if creator_all is not None:
        return creator_all
    if topic is not None:
        return settings.creator_topics.get((creator_id, topic))
    return None


def advance_reminder_fire_at_ms(setting: LiveReminderSetting, scheduled_start_ms: int) -> int | None:
    """When this setting's advance reminder is meant to fire, or None if it has none."""
    if setting.advance_reminder is None:
        return None
    return scheduled_start_ms - ADVANCE_REMINDER_OFFSET_MINUTES[setting.advance_reminder] * 60_000


def is_advance_reminder_due(setting: LiveReminderSetting, scheduled_start_ms: int, *, now_ms: int, window_ms: int) -> bool:
    """Whether the advance (pre-start) reminder's fire window currently contains now_ms.

    window_ms must be at least the dispatcher's own poll interval so a
    reminder is never skipped between two runs (see notification_dispatcher's
    _REMINDER_WINDOW) -- this makes the fire window [fire_at, fire_at +
    window_ms), never earlier than the configured offset, possibly up to
    window_ms late.
    """
    fire_at = advance_reminder_fire_at_ms(setting, scheduled_start_ms)
    if fire_at is None:
        return False
    return fire_at <= now_ms < fire_at + window_ms


def is_start_reminder_due(setting: LiveReminderSetting, scheduled_start_ms: int, *, now_ms: int, window_ms: int) -> bool:
    """Whether the start reminder's fire window currently contains now_ms.

    Uses the stream's own scheduledStartMs, not any discovery timestamp --
    discoveredAt (notification_events_store.py) can be recorded well before
    or independent of a stream's actual scheduled start time.
    """
    if not setting.notify_at_start:
        return False
    return scheduled_start_ms <= now_ms < scheduled_start_ms + window_ms
