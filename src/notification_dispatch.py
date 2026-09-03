"""Per-Client Notification Preferences and Dispatch Decision (Roadmap 4.6).

Pure decision logic: given one client's stored notification preference and
a notification event's `creatorId`, decide whether it should fire right
now, and — for holding a near-real-time event until the client's next
selected delivery window — when the next eligible delivery moment is. No
storage and no AWS dependency of its own: this module only answers
"should/when"; a scheduled dispatcher (itself deferred, blocked on AWS
deployment the same as every other Phase 4 backend module) is the caller
that actually persists delivered-event state and invokes `push_sender.py`.

A preference is stored as an opaque value under Roadmap 4.5's generic
`(clientId, key)` store — this module only defines and validates its
shape (`parse_notification_preference`); it never reads/writes storage
itself, and doesn't know or care what key it's stored under.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from view_growth_analytics import InvalidTimeZoneError, validate_time_zone

# Roadmap 4.6 lists "notificationLevel" as a possible setting without fixing
# its values; "all"/"important" is the initial supported set and may grow.
NOTIFICATION_LEVELS = frozenset({"all", "important"})


class ClientError(ValueError):
    """A clean, safe-to-surface 4xx error for a malformed notification preference.

    Mirrors read_api.py's/remote_config_api.py's ClientError: a stored or
    incoming preference value is untrusted data, not a value this module
    just produced, so it is validated the same as any other external
    input rather than assumed well-formed.
    """


@dataclass(frozen=True)
class NotificationPreference:
    """One client's validated notification preference (Roadmap 4.6's settings list)."""

    enabled: bool
    notification_level: str
    temporary_mute_until: datetime | None
    creator_overrides: dict[str, bool]
    time_zone: str
    delivery_windows: tuple[time, ...]
    quiet_hours: tuple[time, time] | None


def _parse_hhmm(raw: Any, *, field_name: str) -> time:
    """Validate raw is an 'HH:MM' 24-hour wall-clock string and return it as a time."""
    if not isinstance(raw, str):
        raise ClientError(f"{field_name} must be an 'HH:MM' string, got {raw!r}")
    try:
        return datetime.strptime(raw, "%H:%M").time()
    except ValueError:
        raise ClientError(f"{field_name} is not a valid 'HH:MM' time: {raw!r}") from None


def parse_notification_preference(raw: Any) -> NotificationPreference:
    """Validate a stored/incoming notification preference dict into a NotificationPreference.

    Every field is untrusted input (Roadmap 4.5's opaque value, or a
    Dashboard request body) — validated up front the same way read_api.py
    validates a query, so a malformed value is a clean ClientError rather
    than an exception surfacing from deep inside dispatch logic later.
    """
    if not isinstance(raw, dict):
        raise ClientError("notification preference must be an object")

    enabled = raw.get("enabled")
    if not isinstance(enabled, bool):
        raise ClientError(f"enabled is required and must be a boolean, got {enabled!r}")

    notification_level = raw.get("notificationLevel", "all")
    if not isinstance(notification_level, str) or notification_level not in NOTIFICATION_LEVELS:
        raise ClientError(f"notificationLevel must be one of {sorted(NOTIFICATION_LEVELS)}, got {notification_level!r}")

    temporary_mute_until: datetime | None = None
    raw_mute = raw.get("temporaryMute")
    if raw_mute is not None:
        if not isinstance(raw_mute, str) or not raw_mute:
            raise ClientError("temporaryMute must be an ISO 8601 timestamp string with a UTC offset, or null")
        try:
            temporary_mute_until = datetime.fromisoformat(raw_mute)
        except ValueError:
            raise ClientError(f"temporaryMute is not a valid ISO 8601 timestamp: {raw_mute!r}") from None
        if temporary_mute_until.tzinfo is None:
            raise ClientError(f"temporaryMute must include a UTC offset: {raw_mute!r}")

    raw_overrides = raw.get("creatorOverride", {})
    if not isinstance(raw_overrides, dict):
        raise ClientError("creatorOverride must be an object mapping creatorId to a boolean")
    creator_overrides: dict[str, bool] = {}
    for creator_id, value in raw_overrides.items():
        if not isinstance(creator_id, str) or not creator_id:
            raise ClientError(f"creatorOverride keys must be non-empty creatorId strings, got {creator_id!r}")
        if not isinstance(value, bool):
            raise ClientError(f"creatorOverride[{creator_id!r}] must be a boolean, got {value!r}")
        creator_overrides[creator_id] = value

    time_zone = raw.get("notificationTimeZone")
    if not isinstance(time_zone, str) or not time_zone:
        raise ClientError("notificationTimeZone is required and must be a non-empty IANA zone name string")
    try:
        validate_time_zone(time_zone)
    except InvalidTimeZoneError:
        raise ClientError(f"notificationTimeZone is not a valid IANA time zone: {time_zone!r}") from None

    raw_windows = raw.get("deliveryWindows")
    if not isinstance(raw_windows, list) or not raw_windows:
        raise ClientError("deliveryWindows is required and must be a non-empty list of 'HH:MM' strings")
    delivery_windows = tuple(
        sorted({_parse_hhmm(w, field_name="deliveryWindows entry") for w in raw_windows})
    )

    quiet_hours: tuple[time, time] | None = None
    raw_quiet_hours = raw.get("quietHours")
    if raw_quiet_hours is not None:
        if not isinstance(raw_quiet_hours, (list, tuple)) or len(raw_quiet_hours) != 2:
            raise ClientError("quietHours must be a [start, end] pair of 'HH:MM' strings, or null")
        quiet_hours = (
            _parse_hhmm(raw_quiet_hours[0], field_name="quietHours start"),
            _parse_hhmm(raw_quiet_hours[1], field_name="quietHours end"),
        )

    return NotificationPreference(
        enabled=enabled,
        notification_level=notification_level,
        temporary_mute_until=temporary_mute_until,
        creator_overrides=creator_overrides,
        time_zone=time_zone,
        delivery_windows=delivery_windows,
        quiet_hours=quiet_hours,
    )


def is_creator_enabled(preference: NotificationPreference, creator_id: str) -> bool:
    """Whether notifications for creator_id are currently enabled for this client.

    A per-creator override always wins over the global `enabled` flag —
    Roadmap 4.6's own example ("clientId A turns藍沢エマ notification OFF"
    while presumably staying enabled overall) only makes sense if the
    override is authoritative, not merely an additional filter on top of
    a disabled global switch.
    """
    if creator_id in preference.creator_overrides:
        return preference.creator_overrides[creator_id]
    return preference.enabled


def is_temporarily_muted(preference: NotificationPreference, *, now: datetime) -> bool:
    """Whether this client is currently under a still-active temporaryMute."""
    if preference.temporary_mute_until is None:
        return False
    return now < preference.temporary_mute_until


def is_within_quiet_hours(preference: NotificationPreference, *, now: datetime) -> bool:
    """Whether `now`, converted to this client's local wall-clock time, falls inside quietHours.

    Handles a window that wraps past midnight (e.g. 22:00-07:00): such a
    window means "outside [end, start)", not a simple start<=t<=end range.
    """
    if preference.quiet_hours is None:
        return False
    local_time = now.astimezone(ZoneInfo(preference.time_zone)).time()
    start, end = preference.quiet_hours
    if start <= end:
        return start <= local_time < end
    return local_time >= start or local_time < end


def should_notify_now(preference: NotificationPreference, creator_id: str, *, now: datetime) -> bool:
    """Whether a notification for creator_id should fire for this client right now.

    Combines Roadmap 4.6's three suppression rules — creator-level
    enable/override, an active temporaryMute, and quietHours — any one of
    which blocks delivery regardless of the others being satisfied.
    """
    if not is_creator_enabled(preference, creator_id):
        return False
    if is_temporarily_muted(preference, now=now):
        return False
    if is_within_quiet_hours(preference, now=now):
        return False
    return True


def next_delivery_window_utc(preference: NotificationPreference, *, after: datetime) -> datetime:
    """The next UTC instant one of this client's local deliveryWindows occurs, strictly after `after`.

    Roadmap 4.6: a near-real-time event may be held until the client's
    next selected delivery window unless immediate notifications are
    explicitly enabled elsewhere in the caller's own logic — this computes
    that "next window" instant. Converts through the IANA zone (not a
    fixed UTC offset), so it stays correct across a daylight-saving
    transition between `after` and the computed window.
    """
    zone = ZoneInfo(preference.time_zone)
    local_after = after.astimezone(zone)
    after_utc = after.astimezone(timezone.utc)
    candidates: list[datetime] = []
    for day_offset in (0, 1):  # today's remaining windows, then tomorrow's (always >= 1 candidate)
        candidate_date = local_after.date() + timedelta(days=day_offset)
        for window_time in preference.delivery_windows:
            candidate = datetime.combine(candidate_date, window_time, tzinfo=zone)
            # Compare as UTC instants, not same-zone wall-clock values: two
            # aware datetimes sharing one tzinfo object compare as if naive
            # (Python ignores `fold`), so during a repeated local hour (a
            # DST fall-back transition) a first-fold candidate could pass
            # this check even though its actual UTC instant is still before
            # `after`.
            if candidate.astimezone(timezone.utc) > after_utc:
                candidates.append(candidate)
    # Same reasoning as the filter above: select by UTC instant, not by the
    # candidates' shared-tzinfo wall-clock ordering.
    return min(candidate.astimezone(timezone.utc) for candidate in candidates)
