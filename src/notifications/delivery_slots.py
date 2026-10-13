"""Delivery slots for scheduled new-video push delivery.

A client picks at most MAX_SLOTS_PER_CLIENT of the SLOTS_PER_DAY fixed half-hour slots of the JST day (slot 0 is
00:00-00:30 JST, slot 47 is 23:30-24:00 JST). On the wire a slot is the "HH:MM" start of the half hour, in the preference's own
`deliveryWindows` field, so the stored format is unchanged. Slots are always Asia/Tokyo wall-clock times, never the device's or the
stored `notificationTimeZone` (which keeps governing only quiet hours and reminders).

The single 30-minute dispatcher fires on UTC :00/:30 ticks. JST is a whole-hour UTC offset without daylight saving, so every tick
is the start of exactly one JST slot and "who is due now" is one lookup of that slot in the slot-recipient index
(stores/notification_slot_store.py), never a scan of every client.

Pure functions only: no storage, no AWS.
"""

from __future__ import annotations

from datetime import datetime, time, timezone
from typing import Any
from zoneinfo import ZoneInfo

SLOT_MINUTES = 30
SLOTS_PER_DAY = 24 * 60 // SLOT_MINUTES  # 48
MAX_SLOTS_PER_CLIENT = 4

# The zone every delivery slot is expressed in (the product's V1 delivery clock).
DELIVERY_TIME_ZONE = ZoneInfo("Asia/Tokyo")


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
    """The UTC :00/:30 boundary at or before `instant`, with seconds and microseconds dropped."""
    utc = instant.astimezone(timezone.utc)
    return utc.replace(minute=utc.minute - utc.minute % SLOT_MINUTES, second=0, microsecond=0)


def jst_slot(tick: datetime) -> int:
    """The JST slot that `tick` falls in."""
    return slot_of_time(tick.astimezone(DELIVERY_TIME_ZONE).time())


def slot_start_time(slot: int) -> time:
    """The JST wall-clock start of a slot (17 -> 08:30)."""
    if not 0 <= slot < SLOTS_PER_DAY:
        raise ValueError(f"slot must be 0..{SLOTS_PER_DAY - 1}, got {slot!r}")
    return time(slot // 2, SLOT_MINUTES * (slot % 2))


def slot_key(slot: int) -> str:
    """The slot-recipient index's partition key for one JST slot."""
    if not 0 <= slot < SLOTS_PER_DAY:
        raise ValueError(f"slot must be 0..{SLOTS_PER_DAY - 1}, got {slot!r}")
    return f"{slot:02d}"
