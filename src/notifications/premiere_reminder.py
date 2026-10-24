"""One-time Premiere reminder: the rules and storage shape, layered on the same remote-config / dispatcher architecture as live_reminder.py.

A client picks ONE reminder time for ONE upcoming YouTube Premiere (from the Schedule's Premiere details). It is deliberately a separate mechanism
from the livestream reminders, because a Premiere is an uploaded video with a countdown, not a livestream:

    "premiereReminder#<videoId>"  -- {creatorId, reminder}; `reminder` is one of REMINDER_VALUES (exactly one: at the Premiere's scheduled start, or
                                     10 minutes / 30 minutes / 1 hour before it; a reminder already stored with the retired 1-minute choice,
                                     LEGACY_REMINDER_VALUES, is still honored until delivered or cancelled but can no longer be saved). It is its OWN (clientId, configKey) item, so it is a
                                     single-item write that never reads or touches any other setting, and the existing configKey-index answers
                                     "which clients hold a reminder for this Premiere" with no new index or table.

What it is independent of: the creator 全部 / topic live reminders, a livestream stream override, the new-video creator switches and the four daily
New Video delivery slots. It is not resolved through live_reminder.resolve_effective_setting and never enters the livestream schedule entries, so a
Premiere can neither get an ordinary livestream reminder nor take part in a 同時開播預告 collision. Mute, quiet hours, the master switch and the general
per-creator switch still apply (notification_dispatch.should_notify_now), exactly as for a single-stream override.

The Premiere's schedule comes from the SAME derivation that builds the livestream schedule (the shared live/upcoming snapshot, never Holodex or
YouTube): the streams the snapshot lists with status "premiere" are stored in the "streamSchedule" record under the extra top-level field
PREMIERES_FIELD, so reading them costs no extra DynamoDB request and a reschedule is picked up on the snapshot's next refresh. Entries carry the
CURRENT scheduled start only; a reminder never stores a start time of its own.

Lifecycle of an entry (derive_entries): present while the snapshot lists the Premiere; replaced when its start moves; dropped when the snapshot no
longer lists it BEFORE its start (cancelled, deleted, moved out of the window), or when the snapshot now lists the same id as an ordinary upcoming
stream (it is no longer a Premiere). After the scheduled start the snapshot relabels the Premiere (it is airing), so a started entry is carried
forward for CARRY_FORWARD_AFTER_START_MS: just long enough for the at-start reminder and its recovery grace, never to send a late reminder.

Delivery is in notification_dispatcher.py: one send per (client, Premiere, scheduled start minute) under an atomic delivery-log claim in its own
id namespace, then the reminder item is consumed (deleted), so it stops being eligible once delivered.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable, Mapping

from notifications import live_reminder
from stores import remote_config_store

PREMIERE_REMINDER_KEY_PREFIX = "premiereReminder#"

# The one extra field of the "streamSchedule" record's value that carries the Premiere schedule (videoId -> entry).
PREMIERES_FIELD = "premieres"

# The snapshot status of a still-upcoming YouTube Premiere (read_api._without_known_non_livestreams relabels it).
STATUS_PREMIERE = "premiere"

# The choices a client can SAVE (the Schedule's Premiere control, frontend PREMIERE_REMINDER_TIME_VALUES): at the scheduled start, or 10 / 30 / 60 minutes
# before it. The livestream reminders keep their own list (live_reminder.ADVANCE_REMINDER_OFFSET_MINUTES), which still includes 1 minute.
REMINDER_VALUES: tuple[str, ...] = ("at_start", "10min", "30min", "1hour")
# The retired 1-minute Premiere choice: no longer accepted when saving, but an item already stored with it keeps its delivery behavior (it is neither
# converted to another time nor ignored) and can still be cancelled.
LEGACY_REMINDER_VALUES: tuple[str, ...] = ("1min",)
REMINDER_OFFSET_MINUTES: dict[str, int] = {"at_start": 0, "1min": 1, "10min": 10, "30min": 30, "1hour": 60}  # every offset a STORED item can hold

# How long a Premiere whose scheduled start has passed stays in the stored schedule although the snapshot has relabeled it (see the module docstring).
# It must outlast the at-start window plus the dispatcher's start-recovery grace, and it is dropped by the next derivation after that.
CARRY_FORWARD_AFTER_START_MS = 15 * 60_000


@dataclass(frozen=True)
class PremiereReminder:
    """One stored one-time Premiere reminder: which Premiere's creator it belongs to and the single chosen time."""

    creator_id: str
    reminder: str  # one of REMINDER_VALUES
    # When the stored item was last saved (the record's updatedAt); None when unknown. Only the recovery of a missed minute reads it (a reminder saved
    # after its fire time is never replayed), so it is not part of the reminder's identity.
    updated_at: datetime | None = field(default=None, compare=False, repr=False)


@dataclass(frozen=True)
class PremiereEntry:
    """One Premiere in the stored schedule: its creator, the CURRENT scheduled start and its original title (the notification body)."""

    creator_id: str
    scheduled_start_ms: int
    title: str | None = None


def premiere_reminder_key(video_id: str) -> str:
    """The config key of one Premiere's reminder item."""
    return f"{PREMIERE_REMINDER_KEY_PREFIX}{live_reminder.parse_key_part(video_id, name='videoId')}"


def parse_premiere_reminder(raw: Any, *, context: str = "premiere reminder", allow_legacy: bool = False) -> PremiereReminder:
    """Validate a reminder value {creatorId, reminder}; raises live_reminder.ClientError (a safe 4xx message) otherwise.

    An INCOMING value (the API) accepts only REMINDER_VALUES. A STORED one is read with `allow_legacy`, which also accepts LEGACY_REMINDER_VALUES so a
    reminder saved before the 1-minute choice was retired is still delivered."""
    if not isinstance(raw, dict):
        raise live_reminder.ClientError(f"{context} must be an object")
    creator_id = raw.get("creatorId")
    if not isinstance(creator_id, str) or not creator_id:
        raise live_reminder.ClientError(f"{context}.creatorId is required and must be a non-empty string")
    reminder = raw.get("reminder")
    if reminder not in REMINDER_VALUES and not (allow_legacy and reminder in LEGACY_REMINDER_VALUES):
        raise live_reminder.ClientError(f"{context}.reminder must be one of {list(REMINDER_VALUES)}, got {reminder!r}")
    return PremiereReminder(creator_id=creator_id, reminder=reminder)


def fire_at_ms(reminder: str, scheduled_start_ms: int) -> int:
    """When this reminder is meant to fire: the scheduled start minus its offset (the start itself for "at_start")."""
    return scheduled_start_ms - REMINDER_OFFSET_MINUTES[reminder] * 60_000


def is_due(reminder: str, scheduled_start_ms: int, *, now_ms: int, window_ms: int) -> bool:
    """Whether the reminder's fire window [fire_at, fire_at + window_ms) contains now_ms. Never earlier than the chosen time."""
    fire_at = fire_at_ms(reminder, scheduled_start_ms)
    return fire_at <= now_ms < fire_at + window_ms


def is_advance(reminder: str) -> bool:
    """Whether the choice is a pre-start reminder (everything except "at_start")."""
    return reminder != "at_start"


def parse_entries(raw: Any) -> dict[str, PremiereEntry]:
    """The Premiere schedule stored in a "streamSchedule" value ({} when absent). Lenient on purpose: an unusable entry is skipped, never an error,
    so a damaged Premiere entry can only lose its own reminder and never stops the livestream reminders that share the record."""
    entries: dict[str, PremiereEntry] = {}
    if not isinstance(raw, dict):
        return entries
    for video_id, value in raw.items():
        if not isinstance(video_id, str) or not video_id or not isinstance(value, dict):
            continue
        creator_id, start_ms = value.get("creatorId"), value.get("scheduledStartMs")
        if not isinstance(creator_id, str) or not creator_id or isinstance(start_ms, bool) or not isinstance(start_ms, (int, float)):
            continue
        title = value.get("title")
        entries[video_id] = PremiereEntry(creator_id=creator_id, scheduled_start_ms=int(start_ms), title=title if isinstance(title, str) and title.strip() else None)
    return entries


def entries_to_value(entries: Mapping[str, PremiereEntry]) -> dict[str, dict[str, Any]]:
    """The JSON shape stored under PREMIERES_FIELD (the inverse of parse_entries)."""
    value: dict[str, dict[str, Any]] = {}
    for video_id, entry in entries.items():
        item: dict[str, Any] = {"creatorId": entry.creator_id, "scheduledStartMs": entry.scheduled_start_ms}
        if entry.title:
            item["title"] = entry.title
        value[video_id] = item
    return value


def derive_entries(streams: Iterable[Mapping[str, Any]], *, previous: Mapping[str, PremiereEntry], now_ms: int) -> dict[str, PremiereEntry]:
    """The Premiere schedule for the snapshot just read (`streams`, as read_api.get_live_streams lists them), given the previously stored one.

    The snapshot is the only source of a start time: a listed Premiere always takes the current start (a reschedule replaces it). A previously stored
    Premiere the snapshot no longer lists as one survives only while it has STARTED and the carry-forward has not elapsed (it is airing and relabeled);
    one that vanished before its start was cancelled or moved out of the window, and one the snapshot now lists as an ordinary stream is not a
    Premiere any more -- both are dropped, so such a reminder stops being eligible and can never turn into a livestream reminder.
    """
    current: dict[str, PremiereEntry] = {}
    listed_as_other: set[str] = set()
    for stream in streams:
        video_id = stream.get("videoId")
        if not isinstance(video_id, str) or not video_id:
            continue
        if stream.get("status") != STATUS_PREMIERE:
            if stream.get("status") == "upcoming":
                listed_as_other.add(video_id)
            continue
        start_iso, creator_id = stream.get("scheduledStart"), stream.get("creatorId")
        if not isinstance(start_iso, str) or not start_iso or not isinstance(creator_id, str) or not creator_id:
            continue
        try:
            start_ms = int(datetime.fromisoformat(start_iso).timestamp() * 1000)
        except ValueError:
            continue
        title = stream.get("title")
        current[video_id] = PremiereEntry(creator_id=creator_id, scheduled_start_ms=start_ms, title=title if isinstance(title, str) and title.strip() else None)
    for video_id, entry in previous.items():
        if video_id in current or video_id in listed_as_other:
            continue
        if entry.scheduled_start_ms <= now_ms < entry.scheduled_start_ms + CARRY_FORWARD_AFTER_START_MS:
            current[video_id] = entry
    return current


def due_entries(entries: Mapping[str, PremiereEntry], *, now_ms: int, window_ms: int) -> dict[str, PremiereEntry]:
    """The Premieres for which now_ms is the on-time minute of at least one offset a stored reminder can hold (in memory, no I/O)."""
    return {
        video_id: entry
        for video_id, entry in entries.items()
        if any(is_due(reminder, entry.scheduled_start_ms, now_ms=now_ms, window_ms=window_ms) for reminder in REMINDER_OFFSET_MINUTES)
    }


def find_candidates(
    due: Mapping[str, PremiereEntry], *, now_ms: int, window_ms: int
) -> dict[str, dict[str, tuple[PremiereEntry, PremiereReminder]]]:
    """{clientId: {videoId: (entry, reminder)}} for every client whose stored choice is due for one of the `due` Premieres right now.

    One configKey-index Query per due Premiere (the same lookup the livestream overrides use), nothing else; a stored item that fails validation is
    skipped and logged. The entry's own creator is authoritative (the schedule), not the creatorId the client stored.
    """
    candidates: dict[str, dict[str, tuple[PremiereEntry, PremiereReminder]]] = {}
    for video_id, entry in due.items():
        for record in remote_config_store.list_by_key(premiere_reminder_key(video_id)):
            try:
                reminder = parse_premiere_reminder(record["value"], context=record.get("key", "premiere reminder"), allow_legacy=True)
            except live_reminder.ClientError as exc:
                print(f"Warning: skipping invalid stored Premiere reminder for client {record.get('clientId')!r}: {exc}")
                continue
            if not is_due(reminder.reminder, entry.scheduled_start_ms, now_ms=now_ms, window_ms=window_ms):
                continue
            stamped = PremiereReminder(creator_id=entry.creator_id, reminder=reminder.reminder, updated_at=live_reminder.parse_timestamp(record.get("updatedAt")))
            candidates.setdefault(record["clientId"], {})[video_id] = (entry, stamped)
    return candidates
