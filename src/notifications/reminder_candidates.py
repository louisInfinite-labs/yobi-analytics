"""Which (client, stream) live reminders can possibly be due in THIS dispatcher run -- found from the schedule, not by reading every client.

The 1-minute dispatcher used to load every client's stored notification preference (and push subscription, and two reminder Queries) each minute to
learn that, almost always, nothing was due: its DynamoDB reads grew with the number of registered clients, due reminders or not. A reminder's due
moment is a pure function of the stream's scheduled start (live_reminder.is_start_reminder_due / is_advance_reminder_due), so the work is inverted:

1. DUE STREAMS (in memory, no I/O): the streams of the shared "streamSchedule" for which "now" is the on-time minute of the start or of one of the
   advance offsets (1 / 10 / 30 / 60 minutes before), plus -- only when the late-discovery catch-up is switched on -- the streams that may still owe
   a catch-up. Most minutes of most days have none, and such a run reads nothing but the schedule it already needed.
2. FOLLOWERS OF THOSE STREAMS ONLY: the reminder items are themselves the per-creator subscription edges. The remote-config table's configKey-index
   (hash configKey) answers "which clients hold `creatorReminder#<creator>#all`" / "`creatorReminder#<creator>#<topic>`" / "`streamOverride#<video>`"
   with a Query that returns only those clients' (small) items, each carrying the stored setting and its updatedAt. That is every input the
   precedence rule needs (per-stream override > creator 全部 > creator + topic), so the resolution is exactly live_reminder.resolve_effective_setting
   and no per-client reminder Query is left.
3. Only a client whose RESOLVED setting can be due at this very minute (a notify-at-start setting at the start minute, an "advance" setting at its own
   offset ...) is returned; the caller then reads that client's preference and push subscription -- the source of truth for mute, quiet hours, the
   master switch, locale and the subscription -- and runs the unchanged delivery code. So the per-minute reads scale with the followers of streams
   whose reminder minute it is, never with registered clients.

Nothing is stored or indexed for this: the GSI already exists and is maintained by DynamoDB on the reminder writes that were happening anyway, so a user
adding, editing, disabling or removing a reminder needs no extra write and can never leave a derived "due" record out of sync.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, Mapping

from notifications import live_reminder
from stores import remote_config_store

# "Saved before the fire time" for the pre-filter of the catch-up: the real per-client check (does the setting / subscription predate the fire time)
# needs data this module does not read, so here it is assumed satisfied and the delivery code decides.
_ASSUMED_EARLY = datetime(1970, 1, 1, tzinfo=timezone.utc)

_ADVANCE_OFFSETS_MS = tuple(minutes * 60_000 for minutes in live_reminder.ADVANCE_REMINDER_OFFSET_MINUTES.values())


def _on_time_moments_due(entry: live_reminder.StreamScheduleEntry, now_ms: int, window_ms: int) -> bool:
    """Whether now_ms is inside the on-time window of the stream's start or of any advance offset."""
    start = entry.scheduled_start_ms
    return any(
        start - offset <= now_ms < start - offset + window_ms
        for offset in (0, *_ADVANCE_OFFSETS_MS)
    )


def _may_need_catch_up(entry: live_reminder.StreamScheduleEntry, now_ms: int, window_ms: int) -> bool:
    """Whether the late-discovery catch-up may be due for SOME client of this stream: it is still upcoming, its current start was first seen after one
    of the advance fire times, and now is between that fire time's closed window and the last moment a catch-up may be sent."""
    stamp = entry.first_seen
    if entry.status != live_reminder.STATUS_UPCOMING or stamp is None or stamp.first_seen_at is None:
        return False
    start = entry.scheduled_start_ms
    if stamp.start_minute != start // 60_000 or now_ms > start - live_reminder.CATCH_UP_MIN_REMAINING_MS:
        return False
    first_seen_ms = int(stamp.first_seen_at.timestamp() * 1000)
    return any(first_seen_ms > start - offset and now_ms >= start - offset + window_ms for offset in _ADVANCE_OFFSETS_MS)


def due_streams(
    stream_schedule: Mapping[str, live_reminder.StreamScheduleEntry],
    *,
    now_ms: int,
    window_ms: int,
    catch_up_enabled: Callable[[], bool],
) -> tuple[dict[str, live_reminder.StreamScheduleEntry], set[str]]:
    """The streams that can have a reminder due this minute, and the subset for which a late-discovery catch-up is possible too.

    A stream is due when this is the on-time minute of its start or an advance offset, or when it may owe a catch-up. `catch_up_enabled` (the
    dispatcher's lazily-read kill switch) is only asked for a stream that could owe one, so a run with no such stream reads no switch.
    """
    due: dict[str, live_reminder.StreamScheduleEntry] = {}
    catch_up_ids: set[str] = set()
    for video_id, entry in stream_schedule.items():
        if _may_need_catch_up(entry, now_ms, window_ms) and catch_up_enabled():
            due[video_id] = entry
            catch_up_ids.add(video_id)
        elif _on_time_moments_due(entry, now_ms, window_ms):
            due[video_id] = entry
    return due, catch_up_ids


def _setting_may_be_due(
    setting: live_reminder.LiveReminderSetting,
    entry: live_reminder.StreamScheduleEntry,
    *,
    now_ms: int,
    window_ms: int,
    catch_up_possible: bool,
) -> bool:
    """Whether this resolved setting can be due for this stream right now, by the same predicates the delivery code applies (the delivery code still
    decides; this only avoids reading clients that cannot be due)."""
    start = entry.scheduled_start_ms
    if live_reminder.is_start_reminder_due(setting, start, now_ms=now_ms, window_ms=window_ms):
        return True
    if live_reminder.is_advance_reminder_due(setting, start, now_ms=now_ms, window_ms=window_ms):
        return True
    return catch_up_possible and live_reminder.is_advance_catch_up_due(
        setting,
        start,
        now_ms=now_ms,
        window_ms=window_ms,
        status=entry.status,
        first_seen=entry.first_seen,
        subscription_updated_at=_ASSUMED_EARLY,
    )


def find_candidates(
    streams: Mapping[str, live_reminder.StreamScheduleEntry],
    catch_up_ids: set[str],
    *,
    now_ms: int,
    window_ms: int,
) -> dict[str, dict[str, live_reminder.ResolvedReminder]]:
    """{clientId: {videoId: ResolvedReminder}} for every client whose resolved setting can be due for one of `streams` right now (`catch_up_ids`: the streams for which a catch-up may be sent too).

    Queries the configKey-index once per distinct key (a creator's 全部 / topic key, a stream's override key) -- two to three Queries per due stream,
    shared between streams of one creator -- and reads nothing else. A stored item that fails validation is skipped and logged, exactly as before.
    """
    creator_records: dict[str, list[dict[str, Any]]] = {}
    override_records: dict[str, list[dict[str, Any]]] = {}
    queried: set[str] = set()

    def collect(key: str, target: dict[str, list[dict[str, Any]]]) -> None:
        """Query the configKey-index for `key` once and file each client's item under it in `target`."""
        if key in queried:
            return
        queried.add(key)
        for record in remote_config_store.list_by_key(key):
            target.setdefault(record["clientId"], []).append(record)

    for video_id, entry in streams.items():
        collect(live_reminder.creator_reminder_key(entry.creator_id, live_reminder.ALL_TOPICS_SCOPE), creator_records)
        if entry.topic is not None:
            collect(live_reminder.creator_reminder_key(entry.creator_id, entry.topic), creator_records)
        collect(live_reminder.stream_override_key(video_id), override_records)

    candidates: dict[str, dict[str, live_reminder.ResolvedReminder]] = {}
    for client_id in sorted(set(creator_records) | set(override_records)):
        settings = live_reminder.parse_reminder_settings(creator_records.get(client_id, []), override_records.get(client_id, []))
        for key in settings.invalid_keys:
            print(f"Warning: skipping invalid stored reminder item {key!r} for client {client_id!r}")
        for video_id, entry in streams.items():
            setting = live_reminder.resolve_effective_setting(
                video_id=video_id, creator_id=entry.creator_id, topic=entry.topic, settings=settings
            )
            if setting is None:
                continue
            if not _setting_may_be_due(
                setting, entry, now_ms=now_ms, window_ms=window_ms, catch_up_possible=video_id in catch_up_ids
            ):
                continue
            candidates.setdefault(client_id, {})[video_id] = live_reminder.ResolvedReminder(
                creator_id=entry.creator_id,
                scheduled_start_ms=entry.scheduled_start_ms,
                setting=setting,
                stream_title=entry.title,
                status=entry.status,
                first_seen=entry.first_seen,
            )
    return candidates
