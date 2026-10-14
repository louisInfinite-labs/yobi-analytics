"""Delivery slots for scheduled new-video push delivery.

A client picks at most MAX_SLOTS_PER_CLIENT of the SLOTS_PER_DAY half-hour slots of ITS OWN local day (slot 0 is 00:00-00:30, slot 47
is 23:30-24:00). On the wire a slot is the "HH:MM" start of the half hour, in the preference's `deliveryWindows` field, read as wall-clock
time in the preference's own IANA `notificationTimeZone` -- never as Japan time and never as a fixed UTC offset. The canonical
preference is therefore (IANA zone, local wall-clock times); everything below is derived from it.

The single shared dispatcher fires on UTC :00/:15/:30/:45 ticks (every 15 minutes). Every IANA zone's offset is a whole multiple of
15 minutes (+05:45 Nepal, +12:45 Chatham, +08:45 Eucla, +05:30 India, +10:30 Lord Howe ...), so a local :00 or :30 always falls exactly
on one of those ticks: the user who picked 08:00 is eligible at 08:00 local, never a quarter hour later. To know who is due it never converts a client's time to UTC (that value
changes at every daylight-saving transition and would need re-indexing). It goes the other way: for each IANA zone that has any
recipient it asks "which local half-hour slots does this tick start?" (`due_local_slots`) and looks up those (zone, slot) partitions in
the slot-recipient index (stores/notification_slot_store.py). Daylight saving, a changed browser time zone and zones whose offset is not
a whole half hour therefore need no refresh job and no scan of every client.

Pure functions only: no storage, no AWS.
"""

from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

SLOT_MINUTES = 30  # the granularity a user can choose (:00 or :30 of their local clock)
# How often the shared dispatcher runs. 15 minutes is the finest granularity any IANA zone's UTC offset needs, so every local slot start
# coincides with a tick exactly (see the module docstring).
TICK_MINUTES = 15
SLOTS_PER_DAY = 24 * 60 // SLOT_MINUTES  # 48
MAX_SLOTS_PER_CLIENT = 4

# The partition of the slot-recipient index that lists every IANA zone with at least one recipient (see notification_slot_store).
ZONES_PARTITION = "zones"


class InvalidDeliverySlotsError(ValueError):
    """A deliveryWindows value that is not 1..MAX_SLOTS_PER_CLIENT half-hour 'HH:MM' strings."""


def slot_label(slot: int) -> str:
    """The 'HH:MM' start of a slot (0 -> '00:00', 17 -> '08:30')."""
    if not 0 <= slot < SLOTS_PER_DAY:
        raise ValueError(f"slot must be 0..{SLOTS_PER_DAY - 1}, got {slot!r}")
    minutes = slot * SLOT_MINUTES
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def slot_of_time(value: time) -> int:
    """The slot a wall-clock time falls in (08:10 -> the 08:00 slot)."""
    return value.hour * 60 // SLOT_MINUTES + value.minute // SLOT_MINUTES


def parse_slot_label(raw: Any) -> int:
    """A strict slot from an 'HH:MM' string: it must be exactly on a half-hour boundary."""
    if not isinstance(raw, str):
        raise InvalidDeliverySlotsError(f"deliveryWindows entries must be 'HH:MM' strings, got {raw!r}")
    try:
        parsed = datetime.strptime(raw, "%H:%M").time()
    except ValueError:
        raise InvalidDeliverySlotsError(f"deliveryWindows entry is not a valid 'HH:MM' time: {raw!r}") from None
    if parsed.minute % SLOT_MINUTES != 0:
        raise InvalidDeliverySlotsError(f"deliveryWindows entry {raw!r} is not on a half-hour boundary (HH:00 or HH:30)")
    return slot_of_time(parsed)


def parse_strict_slots(raw_windows: list[Any]) -> tuple[int, ...]:
    """Validate a NEW preference write: 1..MAX_SLOTS_PER_CLIENT distinct half-hour slots, returned ascending."""
    slots = sorted({parse_slot_label(entry) for entry in raw_windows})
    if not slots:
        raise InvalidDeliverySlotsError("deliveryWindows must contain at least one delivery slot")
    if len(slots) > MAX_SLOTS_PER_CLIENT:
        raise InvalidDeliverySlotsError(
            f"deliveryWindows allows at most {MAX_SLOTS_PER_CLIENT} distinct delivery slots, got {len(slots)}"
        )
    return tuple(slots)


def normalize_stored_slots(windows: tuple[time, ...]) -> tuple[int, ...]:
    """The slots a STORED preference delivers at, tolerating values written before the 4-slot/half-hour rule.

    Each window is floored to its half hour (08:10 -> 08:00), duplicates collapse, and more than MAX_SLOTS_PER_CLIENT
    keep the earliest ones -- the same way the backfill normalizes them, so the index and the dispatcher always agree.
    """
    return tuple(sorted({slot_of_time(window) for window in windows}))[:MAX_SLOTS_PER_CLIENT]


def floor_to_tick(instant: datetime) -> datetime:
    """The UTC :00/:15/:30/:45 boundary at or before `instant`, with seconds and microseconds dropped."""
    utc = instant.astimezone(timezone.utc)
    return utc.replace(minute=utc.minute - utc.minute % TICK_MINUTES, second=0, microsecond=0)


def slot_start_time(slot: int) -> time:
    """The local wall-clock start of a slot (17 -> 08:30)."""
    if not 0 <= slot < SLOTS_PER_DAY:
        raise ValueError(f"slot must be 0..{SLOTS_PER_DAY - 1}, got {slot!r}")
    return time(slot // 2, SLOT_MINUTES * (slot % 2))


def zone_slot_key(zone: str, slot: int) -> str:
    """The slot-recipient index's partition key for one local slot of one IANA zone ('Asia/Tokyo|16')."""
    if not 0 <= slot < SLOTS_PER_DAY:
        raise ValueError(f"slot must be 0..{SLOTS_PER_DAY - 1}, got {slot!r}")
    if not zone or "|" in zone or zone == ZONES_PARTITION:
        raise ValueError(f"not a usable IANA zone key: {zone!r}")
    return f"{zone}|{slot:02d}"


def due_local_slots(tick: datetime, zone: str) -> tuple[int, ...]:
    """The local half-hour slots of `zone` that the UTC `tick` serves, ascending.

    A slot is served at the first tick at or after the instant its wall-clock time occurs (exactly that instant for every real zone, since offsets are
    multiples of the 15-minute tick), computed exactly as
    notification_dispatch.next_delivery_window_utc computes a delivery window (a local date + the slot's wall-clock time, converted
    through the IANA zone), so "when is this slot due" and "may this event be sent now" can never disagree. Normally that is exactly
    one slot per tick: 08:00 local is served at the tick that is 08:00 there. Special cases follow from the same rule:

    * a zone whose offset is a quarter hour (+05:45) is served exactly on the slot start too: 08:00 Kathmandu is 02:15 UTC, a tick;
    * a wall-clock time that does not exist because clocks jumped forward (02:30 on a 02:00 -> 03:00 day) occurs at the instant Python's
      zone rules resolve it to (03:30), and is served then -- never skipped;
    * a wall-clock time that happens twice because clocks went back is served at its FIRST occurrence only, so it is not sent twice.

    The work is a fixed 48 slots x 3 local dates per zone per tick, independent of how many clients exist. Were a zone ever to have an
    offset that is not a multiple of the tick, its slot would still be served at the first tick after the start (at most 14 minutes late).
    """
    zone_info = ZoneInfo(zone)
    utc_tick = tick.astimezone(timezone.utc)
    earliest = utc_tick - timedelta(minutes=TICK_MINUTES)  # exclusive: an instant at exactly the previous tick belongs to that tick
    local_date = utc_tick.astimezone(zone_info).date()
    due: set[int] = set()
    for day_offset in (-1, 0, 1):  # the local date may differ from the tick's own around midnight and across offset changes
        date = local_date + timedelta(days=day_offset)
        for slot in range(SLOTS_PER_DAY):
            instant = datetime.combine(date, slot_start_time(slot), tzinfo=zone_info).astimezone(timezone.utc)
            if earliest < instant <= utc_tick:
                due.add(slot)
    return tuple(sorted(due))
