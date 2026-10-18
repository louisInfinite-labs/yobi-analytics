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

    "streamSchedule"  -- {entries: videoId -> StreamScheduleEntry, refreshedAt,
                         sourceRefreshedAt}
                         -- the SOLE source of scheduledStartMs (and of a
                         stream's topic) at dispatch time, derived from the
                         shared live/upcoming snapshot. sourceRefreshedAt is
                         the refresh time of the snapshot it was derived from:
                         the dispatcher re-derives it as soon as the shared
                         snapshot is newer, so a stored start time is never
                         older than the snapshot itself (see
                         notification_dispatcher.py's
                         _refresh_and_load_stream_schedule; refreshedAt and
                         _SCHEDULE_REFRESH_INTERVAL are only the fallback when
                         the snapshot's own freshness is unknown).

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

Late-discovery catch-up (docs/late-discovery-advance-catch-up.md): the on-time
window of an advance reminder is [fire_at, fire_at + 1 min), so a stream that
first appears in the shared snapshot AFTER its fire time can never be reminded on
time. The "streamSchedule" record therefore also carries a top-level "firstSeen"
map ({videoId: {startMinute, firstSeenAt, priorStartMinutes}}) and each entry's
"status", from which is_advance_catch_up_due decides whether ONE honest "about N
minutes" reminder may still be sent. The on-time path is not changed by it.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from typing import Any

from tracking.video_topics import OTHER_TOPIC, TOPIC_IDS, LiveSet

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
# (A live view over the Topic Catalog, not frozen at import.)
REMINDER_TOPIC_IDS = LiveSet(lambda: frozenset(TOPIC_IDS) - {OTHER_TOPIC})

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

# --- late-discovery catch-up (docs/late-discovery-advance-catch-up.md) ---
# The kill switch: a system-wide record (SYSTEM_CLIENT_ID, this key) whose value {"enabled": true} turns the catch-up SEND on. Absent, malformed or
# unreadable means OFF. It gates only the catch-up send; the on-time reminders and the start reminder never consult it.
CATCH_UP_FLAG_KEY = "lateAdvanceCatchUp"
# The top-level map inside the "streamSchedule" value that holds every stream's FirstSeen.
FIRST_SEEN_KEY = "firstSeen"
# A catch-up is never sent closer to the start than this: "about 1 minute" would be noise, and the start reminder follows right after.
CATCH_UP_MIN_REMAINING_MS = 2 * 60_000
# How many earlier start minutes a stream's FirstSeen remembers (the oldest are dropped first). See FirstSeen.
MAX_PRIOR_START_MINUTES = 8
# A stream's FirstSeen is kept this long past its start even after it has left the shared snapshot, so a one-snapshot dropout (Holodex omitting it
# once) cannot make a known stream look newly discovered when it returns.
FIRST_SEEN_RETENTION_AFTER_START_MS = 2 * 60 * 60_000
# The status under which a stream may still get a catch-up.
STATUS_UPCOMING = "upcoming"


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
    # When the stored item holding this setting was last saved (the record's updatedAt); None when unknown. Only the late-discovery catch-up reads it
    # (a setting saved after the original fire time is never sent retroactively), so it is not part of the setting's identity: excluded from equality.
    updated_at: datetime | None = field(default=None, compare=False, repr=False)


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
    # The stream's own (original-language) title, shown as the notification body. Optional: a snapshot written before titles were
    # stored has none, and the notification then uses its localized fallback body.
    title: str | None = None
    # The three fields below exist only for the late-discovery catch-up (see FirstSeen) and are not part of an entry's identity, so they stay out of
    # equality: the stream's status when the schedule was derived ("upcoming" / "live" / ...; None for a record written before it was stored)...
    status: str | None = field(default=None, compare=False, repr=False)
    # ...and when the CURRENT start time was first observed (None: unknown / known before tracking began, which never qualifies for a catch-up).
    first_seen: FirstSeen | None = field(default=None, compare=False, repr=False)


@dataclass(frozen=True)
class FirstSeen:
    """When one stream's CURRENT scheduled start was first observed in the shared snapshot, and which start times it had before.

    `first_seen_at` is the refresh time of the snapshot that first carried this start (not the time the dispatcher derived it). None means "known
    before first-seen tracking began, or tracking could not be trusted for it" and never qualifies for a catch-up.

    `prior_start_minutes` are the start minutes (epoch minutes) this stream had before the current one, oldest first. They exist for one reason:
    the catch-up must not send when an advance reminder was already handled for an earlier start (each start minute is its own dedupe target).
    Only the most recent MAX_PRIOR_START_MINUTES are kept, so a stream rescheduled more often than that forgets its oldest start: an advance
    reminder delivered for that forgotten start can no longer be found, which is the documented limit of that guard.
    """

    start_minute: int
    first_seen_at: datetime | None
    prior_start_minutes: tuple[int, ...] = ()


@dataclass(frozen=True)
class StreamScheduleSnapshot:
    """The persisted "streamSchedule" record's full parsed shape: the
    schedule entries themselves, plus when they were last successfully
    refreshed from Holodex -- the staleness check that decouples 1-minute
    reminder evaluation from how often Holodex is actually queried (see
    notification_dispatcher.py's _SCHEDULE_REFRESH_INTERVAL)."""

    entries: dict[str, StreamScheduleEntry]
    refreshed_at: datetime
    # When the shared live/upcoming snapshot these entries were derived from was itself last refreshed; None for a record written before this
    # was tracked (it is then re-derived once) or whenever that freshness was unknown.
    source_refreshed_at: datetime | None = None
    # The top-level "firstSeen" map (videoId -> FirstSeen). None when the record has no usable map (written before first-seen tracking existed): the
    # next derivation then stamps every stream it carries as "known" instead of new. A stream outlives its schedule entry here for a while so a
    # one-snapshot dropout cannot make a known stream look newly discovered. Not part of equality.
    first_seen: dict[str, FirstSeen] | None = field(default=None, compare=False, repr=False)


@dataclass(frozen=True)
class ResolvedReminder:
    """One (videoId, client) pair's fully-resolved, ready-to-dispatch
    reminder: the CURRENT scheduledStartMs (always from StreamScheduleEntry,
    never from a stored override) plus whichever LiveReminderSetting won
    (see resolve_effective_setting)."""

    creator_id: str
    scheduled_start_ms: int
    setting: LiveReminderSetting
    stream_title: str | None = None
    # Carried from the schedule entry for the late-discovery catch-up only; not part of the reminder's identity.
    status: str | None = field(default=None, compare=False, repr=False)
    first_seen: FirstSeen | None = field(default=None, compare=False, repr=False)


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


def parse_timestamp(raw: Any) -> datetime | None:
    """An ISO 8601 timestamp WITH a UTC offset as an aware datetime; None for anything else (missing, non-string, unparseable, offset-less).

    Lenient on purpose: every caller uses a timestamp only as a safety gate that fails closed, so an unusable value means "unknown" and can
    never invalidate a stored item.
    """
    if not isinstance(raw, str) or not raw:
        return None
    try:
        moment = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else None


def _stamped(setting: LiveReminderSetting, record: dict[str, Any]) -> LiveReminderSetting:
    """The setting carrying when its stored item was last saved (the record's updatedAt), when that is known."""
    return replace(setting, updated_at=parse_timestamp(record.get("updatedAt")))


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
            setting = _stamped(parse_live_reminder_setting(record["value"], context=key), record)
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
            override = parse_stream_override(record["value"], context=key)
            stream_overrides[video_id] = StreamReminderOverride(creator_id=override.creator_id, setting=_stamped(override.setting, record))
        except ClientError:
            invalid.append(key)

    return ReminderSettings(
        creator_all=creator_all,
        creator_topics=creator_topics,
        stream_overrides=stream_overrides,
        invalid_keys=tuple(invalid),
    )


def _parse_schedule_entries(raw: Any, first_seen: dict[str, FirstSeen] | None = None) -> dict[str, StreamScheduleEntry]:
    """The schedule's entries as {videoId: StreamScheduleEntry}, each joined with its FirstSeen stamp when one for its current start exists."""
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
        # Optional and lenient: a missing or non-string title only means the notification body falls back; it never invalidates the snapshot.
        raw_title = value.get("title")
        title = raw_title if isinstance(raw_title, str) and raw_title.strip() else None
        # Optional and lenient like the title: only the late-discovery catch-up reads it, and a missing value just means "no catch-up".
        raw_status = value.get("status")
        status = raw_status if isinstance(raw_status, str) and raw_status else None
        stamp = (first_seen or {}).get(video_id)
        if stamp is not None and stamp.start_minute != scheduled_start_ms // 60_000:
            stamp = None  # a stamp for another start time says nothing about this one
        result[video_id] = StreamScheduleEntry(
            creator_id=creator_id, scheduled_start_ms=scheduled_start_ms, topic=topic, title=title, status=status, first_seen=stamp
        )
    return result


def parse_first_seen_map(raw: Any) -> dict[str, FirstSeen] | None:
    """The stored top-level "firstSeen" map as {videoId: FirstSeen}, or None when there is no usable map at all (absent or not an object).

    None and an empty dict differ on purpose: None is a record written before first-seen tracking existed (the next derivation must treat every
    stream it carries as already known), {} is a tracked record that simply holds no stamps. Lenient per item: an unusable item is dropped (that
    stream is then "known without a stamp", which never qualifies for a catch-up) and can never invalidate the schedule.
    """
    if not isinstance(raw, dict):
        return None
    parsed: dict[str, FirstSeen] = {}
    for video_id, value in raw.items():
        if not isinstance(video_id, str) or not video_id or not isinstance(value, dict):
            continue
        start_minute = value.get("startMinute")
        if not isinstance(start_minute, int) or isinstance(start_minute, bool):
            continue
        prior_raw = value.get("priorStartMinutes")
        prior = tuple(m for m in prior_raw if isinstance(m, int) and not isinstance(m, bool)) if isinstance(prior_raw, list) else ()
        parsed[video_id] = FirstSeen(
            start_minute=start_minute,
            first_seen_at=parse_timestamp(value.get("firstSeenAt")),
            prior_start_minutes=prior[-MAX_PRIOR_START_MINUTES:],
        )
    return parsed


def first_seen_to_value(stamps: dict[str, FirstSeen]) -> dict[str, dict[str, Any]]:
    """The storable form of the firstSeen map (the inverse of parse_first_seen_map)."""
    return {
        video_id: {
            "startMinute": stamp.start_minute,
            "firstSeenAt": stamp.first_seen_at.isoformat() if stamp.first_seen_at is not None else None,
            "priorStartMinutes": list(stamp.prior_start_minutes),
        }
        for video_id, stamp in stamps.items()
    }


def derive_first_seen(
    *,
    previous: StreamScheduleSnapshot | None,
    entries: dict[str, dict[str, Any]],
    observed_at: datetime | None,
    now: datetime,
    max_source_gap: timedelta,
) -> dict[str, FirstSeen]:
    """The firstSeen map for a freshly derived schedule: `entries` is the new raw {videoId: {scheduledStartMs, ...}} map, `observed_at` is the
    refresh time of the shared snapshot it came from (None when that cannot be known, which makes tracking untrusted), `now` is the derivation time
    (only used to expire stamps).

    A stream the previous record already knew keeps its stamp while its start minute is unchanged. A changed start minute is a reschedule: a new
    stamp at `observed_at`, remembering the old minute in prior_start_minutes (most recent MAX_PRIOR_START_MINUTES only). A stream the previous
    record did not know at all is newly discovered: stamped `observed_at` -- unless first-seen tracking cannot be trusted for this derivation, in
    which case every stream without a trusted history is stamped None ("known", never a catch-up). Tracking is untrusted when:

    - there is no previous record, or it predates first-seen tracking (the deploy case: without this guard every stream already in the schedule
      would look new and burst catch-ups to every client with a 30-minute or 1-hour reminder),
    - the previous record's own source refresh time is unknown, or older than `max_source_gap` before this one (an outage: after it, streams that
      Holodex had listed for hours would otherwise look new).

    A stamp outlives its stream's schedule entry until FIRST_SEEN_RETENTION_AFTER_START_MS past the start, so a one-snapshot Holodex dropout does
    not make the returning stream look new.
    """
    previous_stamps = previous.first_seen if previous is not None else None
    trusted = (
        observed_at is not None
        and previous is not None
        and previous_stamps is not None
        and previous.source_refreshed_at is not None
        and timedelta(0) <= observed_at - previous.source_refreshed_at <= max_source_gap
    )
    result: dict[str, FirstSeen] = {}
    for video_id, value in entries.items():
        minute = value["scheduledStartMs"] // 60_000
        stamp = (previous_stamps or {}).get(video_id)
        known_entry = previous.entries.get(video_id) if previous is not None else None
        old_minute = stamp.start_minute if stamp is not None else (known_entry.scheduled_start_ms // 60_000 if known_entry is not None else None)
        base_prior = stamp.prior_start_minutes if stamp is not None else ()
        if old_minute is None:  # never seen before
            result[video_id] = FirstSeen(minute, observed_at if trusted else None, ())
        elif old_minute == minute:  # unchanged start: whatever we knew stays true (a lost stamp for a known entry stays "known")
            result[video_id] = stamp if stamp is not None else FirstSeen(minute, None, ())
        else:  # rescheduled: the new start is a new observation
            prior = (base_prior + (old_minute,))[-MAX_PRIOR_START_MINUTES:]
            result[video_id] = FirstSeen(minute, observed_at if trusted else None, prior)
    horizon_ms = _epoch_ms(now) - FIRST_SEEN_RETENTION_AFTER_START_MS
    for video_id, stamp in (previous_stamps or {}).items():
        if video_id not in result and stamp.start_minute * 60_000 > horizon_ms:
            result[video_id] = stamp
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
    first_seen = parse_first_seen_map(raw.get(FIRST_SEEN_KEY))
    entries = _parse_schedule_entries(raw.get("entries", {}), first_seen)
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
    return StreamScheduleSnapshot(
        entries=entries,
        refreshed_at=refreshed_at,
        source_refreshed_at=_parse_source_refreshed_at(raw.get("sourceRefreshedAt")),
        first_seen=first_seen,
    )


def _parse_source_refreshed_at(raw: Any) -> datetime | None:
    """The optional sourceRefreshedAt as an aware datetime. Lenient on purpose: it is only a hint that avoids needless re-derivation, so a missing,
    malformed or offset-less value means "unknown" (the record is simply re-derived), never an invalid schedule that would stop every reminder."""
    if not isinstance(raw, str) or not raw:
        return None
    try:
        moment = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else None


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

    The product's 開播時通知 means "at the stored scheduled start time": this
    is purely a clock comparison against the stored schedule. It does NOT wait
    for, and never needs, a Holodex or YouTube confirmation that the stream is
    actually live (the notification wording says so -- see notification_text).
    A creator who starts late, or never, still gets the reminder at the time
    that was announced.
    """
    if not setting.notify_at_start:
        return False
    return scheduled_start_ms <= now_ms < scheduled_start_ms + window_ms


def _epoch_ms(moment: datetime) -> int:
    """An aware datetime as epoch milliseconds."""
    return int(moment.timestamp() * 1000)


def is_advance_catch_up_due(
    setting: LiveReminderSetting,
    scheduled_start_ms: int,
    *,
    now_ms: int,
    window_ms: int,
    status: str | None,
    first_seen: FirstSeen | None,
    subscription_updated_at: datetime | None,
) -> bool:
    """Whether a LATE-DISCOVERED stream's advance reminder is due as a catch-up at now_ms.

    The on-time reminder owns [fire_at, fire_at + window_ms) (is_advance_reminder_due, untouched). A catch-up exists for the one case that window can
    never serve: the stream first appeared in the shared snapshot AFTER its fire time, so nobody could have been reminded on time. It is due only when
    ALL of these hold (the checks that need a mute / quiet-hours decision, the kill switch and the delivery log live in the dispatcher):

    - the setting has an advance reminder, and the stream is still "upcoming" (a stream already live gets none);
    - the on-time window has closed (now >= fire_at + window_ms), and the stream is at least CATCH_UP_MIN_REMAINING_MS from its start: never at or
      after the start, never within the last two minutes;
    - the CURRENT start time was first observed after the fire time (a stream known before it was never "late": nothing is backfilled, so a
      delayed dispatcher run or a reminder turned on later sends nothing), and that stamp belongs to the current start minute;
    - the setting's stored item AND the push subscription both existed at the fire time (updatedAt <= fire_at): a reminder enabled, edited or
      re-subscribed after the original trigger moment is never sent retroactively, exactly like a switch turned ON after the due moment. An unknown
      timestamp fails closed.
    """
    fire_at = advance_reminder_fire_at_ms(setting, scheduled_start_ms)
    if fire_at is None or status != STATUS_UPCOMING:
        return False
    if now_ms < fire_at + window_ms or now_ms > scheduled_start_ms - CATCH_UP_MIN_REMAINING_MS:
        return False
    if first_seen is None or first_seen.first_seen_at is None or first_seen.start_minute != scheduled_start_ms // 60_000:
        return False
    if _epoch_ms(first_seen.first_seen_at) <= fire_at:
        return False
    for saved_at in (setting.updated_at, subscription_updated_at):
        if saved_at is None or _epoch_ms(saved_at) > fire_at:
            return False
    return True


def catch_up_remaining_minutes(scheduled_start_ms: int, now_ms: int) -> int:
    """The whole minutes to name in a catch-up notification: the actual time left to the scheduled start, rounded to the nearest minute, never
    below 2 (the catch-up is never sent closer than CATCH_UP_MIN_REMAINING_MS)."""
    return max(CATCH_UP_MIN_REMAINING_MS // 60_000, int((scheduled_start_ms - now_ms) / 60_000 + 0.5))
