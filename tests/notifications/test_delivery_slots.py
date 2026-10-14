from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from notifications.delivery_slots import (
    MAX_SLOTS_PER_CLIENT,
    SLOTS_PER_DAY,
    TICK_MINUTES,
    ZONES_PARTITION,
    InvalidDeliverySlotsError,
    due_local_slots,
    floor_to_tick,
    normalize_stored_slots,
    parse_slot_label,
    parse_strict_slots,
    slot_label,
    slot_of_time,
    slot_start_time,
    zone_slot_key,
)


def test_there_are_48_half_hour_slots_and_at_most_4_per_client():
    assert SLOTS_PER_DAY == 48
    assert MAX_SLOTS_PER_CLIENT == 4


def test_every_slot_round_trips_through_its_label():
    labels = [slot_label(slot) for slot in range(SLOTS_PER_DAY)]

    assert labels[0] == "00:00" and labels[1] == "00:30" and labels[17] == "08:30" and labels[47] == "23:30"
    assert [parse_slot_label(label) for label in labels] == list(range(SLOTS_PER_DAY))
    assert len(set(labels)) == SLOTS_PER_DAY


@pytest.mark.parametrize("slot", [-1, 48, 100])
def test_a_label_for_a_slot_outside_the_day_is_rejected(slot):
    with pytest.raises(ValueError):
        slot_label(slot)
    with pytest.raises(ValueError):
        zone_slot_key("Asia/Tokyo", slot)


@pytest.mark.parametrize("raw", ["08:10", "08:45", "00:01", "23:59", "8:00x", "", "25:00", "08-00", None, 800, ["08:00"]])
def test_a_strict_slot_must_be_exactly_on_a_half_hour(raw):
    with pytest.raises(InvalidDeliverySlotsError):
        parse_slot_label(raw)


def test_a_valid_selection_is_deduplicated_and_sorted():
    assert parse_strict_slots(["18:00", "08:00", "08:00", "12:30"]) == (16, 25, 36)


def test_a_selection_may_have_up_to_four_slots_but_not_more_or_none():
    assert parse_strict_slots(["00:00", "06:00", "12:00", "18:00"]) == (0, 12, 24, 36)
    with pytest.raises(InvalidDeliverySlotsError):
        parse_strict_slots(["00:00", "06:00", "12:00", "18:00", "21:00"])
    with pytest.raises(InvalidDeliverySlotsError):
        parse_strict_slots([])


def test_five_entries_that_collapse_to_four_distinct_slots_are_accepted():
    assert len(parse_strict_slots(["00:00", "00:00", "06:00", "12:00", "18:00"])) == 4


def test_a_stored_legacy_preference_is_floored_deduplicated_and_capped_at_four():
    # Slots: 08:10 and 08:20 -> 16, 18:55 -> 37, 06:00 -> 12, 07:00 -> 14, 09:00 -> 18. Distinct, ascending: 12, 14, 16, 18, 37 -- five,
    # so the earliest four are kept.
    legacy = tuple(time(h, m) for h, m in [(8, 10), (8, 20), (18, 55), (6, 0), (7, 0), (9, 0)])

    assert normalize_stored_slots(legacy) == (12, 14, 16, 18)


def test_slot_of_time_floors_within_the_half_hour():
    assert slot_of_time(time(8, 29)) == 16
    assert slot_of_time(time(8, 30)) == 17
    assert slot_of_time(time(23, 59)) == 47


@pytest.mark.parametrize(
    ("instant", "expected"),
    [
        (datetime(2026, 9, 3, 9, 0, 0, tzinfo=timezone.utc), "2026-09-03T09:00:00+00:00"),
        (datetime(2026, 9, 3, 9, 14, 59, 999999, tzinfo=timezone.utc), "2026-09-03T09:00:00+00:00"),
        (datetime(2026, 9, 3, 9, 29, 59, 999999, tzinfo=timezone.utc), "2026-09-03T09:15:00+00:00"),
        (datetime(2026, 9, 3, 9, 30, 1, tzinfo=timezone.utc), "2026-09-03T09:30:00+00:00"),
        (datetime(2026, 9, 3, 9, 45, 1, tzinfo=timezone.utc), "2026-09-03T09:45:00+00:00"),
        (datetime(2026, 9, 3, 18, 40, tzinfo=timezone.utc).astimezone(ZoneInfo("Asia/Tokyo")), "2026-09-03T18:30:00+00:00"),  # any zone in, UTC out
    ],
)
def test_a_tick_is_the_utc_quarter_hour_at_or_before_the_instant(instant, expected):
    assert floor_to_tick(instant).isoformat() == expected


def _tick(year, month, day, hour, minute=0):
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


@pytest.mark.parametrize(
    ("zone", "tick", "expected_slots"),
    [
        # The user's own clock decides: 08:00 / 18:00 LOCAL, never Japan time.
        ("Asia/Hong_Kong", _tick(2026, 9, 3, 0, 0), (16,)),  # 08:00 in Hong Kong is 00:00 UTC (09:00 JST)
        ("Asia/Hong_Kong", _tick(2026, 9, 3, 10, 0), (36,)),  # 18:00 in Hong Kong is 10:00 UTC (19:00 JST)
        ("Asia/Tokyo", _tick(2026, 9, 2, 23, 0), (16,)),  # 08:00 JST
        ("Asia/Tokyo", _tick(2026, 9, 3, 9, 0), (36,)),  # 18:00 JST
        ("Asia/Tokyo", _tick(2026, 9, 2, 15, 0), (0,)),  # midnight wraps to the next local day
        ("Asia/Tokyo", _tick(2026, 9, 2, 14, 30), (47,)),
        ("America/New_York", _tick(2026, 7, 3, 12, 0), (16,)),  # EDT (UTC-4): 08:00 local is 12:00 UTC
        ("America/New_York", _tick(2026, 12, 3, 13, 0), (16,)),  # EST (UTC-5): 08:00 local is 13:00 UTC
        ("Europe/London", _tick(2026, 7, 3, 7, 0), (16,)),  # BST (UTC+1)
        ("Europe/London", _tick(2026, 12, 3, 8, 0), (16,)),  # GMT
    ],
)
def test_a_tick_starts_the_local_slot_of_each_zone(zone, tick, expected_slots):
    assert due_local_slots(tick, zone) == expected_slots


def test_the_same_local_time_stays_local_across_a_daylight_saving_transition():
    # "08:00 New York" is 12:00 UTC before the 2026-11-01 fall-back and 13:00 UTC after it: the slot key never changes, only the tick.
    before, after = _tick(2026, 10, 31, 12, 0), _tick(2026, 11, 2, 13, 0)
    assert due_local_slots(before, "America/New_York") == due_local_slots(after, "America/New_York") == (16,)
    assert due_local_slots(_tick(2026, 11, 2, 12, 0), "America/New_York") == (14,)  # the old UTC tick is now 07:00 local


@pytest.mark.parametrize(
    ("zone", "local_time", "utc_tick"),
    [
        # The notification is eligible at EXACTLY the local time the user picked -- never a quarter hour later -- in every zone, whatever
        # its UTC offset looks like.
        ("Asia/Hong_Kong", "08:00", _tick(2026, 9, 3, 0, 0)),  # +08:00; the same 08:00 is 09:00 JST
        ("Asia/Tokyo", "08:00", _tick(2026, 9, 2, 23, 0)),  # +09:00
        ("Asia/Kathmandu", "08:00", _tick(2026, 9, 3, 2, 15)),  # +05:45: 08:00 local is 02:15 UTC
        ("Asia/Kathmandu", "08:30", _tick(2026, 9, 3, 2, 45)),
        ("Asia/Kolkata", "08:00", _tick(2026, 9, 3, 2, 30)),  # +05:30
        ("Australia/Eucla", "08:00", _tick(2026, 9, 2, 23, 15)),  # +08:45
        ("Pacific/Chatham", "08:00", _tick(2026, 9, 2, 19, 15)),  # +12:45 (standard time in early September)
        ("Pacific/Marquesas", "08:30", _tick(2026, 9, 3, 18, 0)),  # -09:30
        ("America/St_Johns", "08:00", _tick(2026, 12, 3, 11, 30)),  # -03:30 (standard time)
    ],
)
def test_a_local_time_is_served_at_exactly_that_local_time_in_every_zone(zone, local_time, utc_tick):
    slot = parse_slot_label(local_time)
    assert slot in due_local_slots(utc_tick, zone)
    assert utc_tick.astimezone(ZoneInfo(zone)).strftime("%H:%M") == local_time  # the tick IS that wall-clock time: not 08:15, not 07:45
    # ...and it is not served a tick early or a tick late
    assert slot not in due_local_slots(utc_tick - timedelta(minutes=TICK_MINUTES), zone)
    assert slot not in due_local_slots(utc_tick + timedelta(minutes=TICK_MINUTES), zone)


def test_a_quarter_hour_offset_zone_has_no_slot_at_its_off_ticks():
    # Kathmandu: 02:00 UTC is 07:45 local -- not a half-hour slot, so that tick serves nobody there; 02:15 UTC is exactly 08:00.
    assert due_local_slots(_tick(2026, 9, 3, 2, 0), "Asia/Kathmandu") == ()
    assert due_local_slots(_tick(2026, 9, 3, 2, 15), "Asia/Kathmandu") == (16,)
    assert due_local_slots(_tick(2026, 9, 3, 2, 30), "Asia/Kathmandu") == ()
    assert due_local_slots(_tick(2026, 9, 3, 2, 45), "Asia/Kathmandu") == (17,)


@pytest.mark.parametrize(
    "zone",
    ["Asia/Tokyo", "Asia/Hong_Kong", "Asia/Kolkata", "Asia/Kathmandu", "Australia/Eucla", "Pacific/Chatham", "Pacific/Marquesas", "America/St_Johns"],
)
def test_on_an_ordinary_day_every_slot_is_served_exactly_once_and_always_at_its_own_wall_clock_time(zone):
    ticks = [_tick(2026, 9, 3, 0, 0) + timedelta(minutes=TICK_MINUTES * index) for index in range(96)]
    served = []
    for tick in ticks:
        for slot in due_local_slots(tick, zone):
            served.append(slot)
            assert tick.astimezone(ZoneInfo(zone)).time() == slot_start_time(slot)  # exact, never shifted
    assert sorted(served) == list(range(SLOTS_PER_DAY))


@pytest.mark.parametrize(
    ("zone", "before", "after", "local_time"),
    [
        # 08:00 local stays 08:00 local across BOTH transitions of each zone (the UTC tick moves, the local time does not).
        ("America/New_York", _tick(2026, 3, 7, 13, 0), _tick(2026, 3, 9, 12, 0), "08:00"),  # spring forward: EST 13:00 UTC -> EDT 12:00 UTC
        ("America/New_York", _tick(2026, 10, 31, 12, 0), _tick(2026, 11, 2, 13, 0), "08:00"),  # fall back
        ("Europe/London", _tick(2026, 3, 27, 8, 0), _tick(2026, 3, 30, 7, 0), "08:00"),
        ("Europe/London", _tick(2026, 10, 24, 7, 0), _tick(2026, 10, 27, 8, 0), "08:00"),
        ("Pacific/Chatham", _tick(2026, 9, 25, 19, 15), _tick(2026, 9, 29, 18, 15), "08:00"),  # +12:45 -> +13:45: 45-minute offsets AND DST
        ("Pacific/Chatham", _tick(2027, 4, 2, 18, 15), _tick(2027, 4, 6, 19, 15), "08:00"),
        ("Australia/Lord_Howe", _tick(2026, 10, 2, 21, 30), _tick(2026, 10, 6, 21, 0), "08:00"),  # +10:30 -> +11:00 (a 30-minute DST shift)
    ],
)
def test_a_local_time_stays_exactly_that_local_time_before_and_after_each_daylight_saving_transition(zone, before, after, local_time):
    slot = parse_slot_label(local_time)
    for tick in (before, after):
        assert tick.astimezone(ZoneInfo(zone)).strftime("%H:%M") == local_time  # the test's own arithmetic is right
        assert slot in due_local_slots(tick, zone)
        assert slot not in due_local_slots(tick - timedelta(minutes=TICK_MINUTES), zone)
        assert slot not in due_local_slots(tick + timedelta(minutes=TICK_MINUTES), zone)


def test_a_spring_forward_gap_slot_is_served_at_the_instant_the_zone_rules_resolve_it_to():
    # New York, 2026-03-08: 02:00 EST jumps to 03:00 EDT. 02:00 and 02:30 do not exist that day; they resolve to 03:00 and 03:30 EDT,
    # the very instants next_delivery_window_utc uses, so a client choosing 02:30 is served at 03:30 EDT instead of never.
    assert due_local_slots(_tick(2026, 3, 8, 6, 30), "America/New_York") == (3,)  # 01:30 EST
    assert due_local_slots(_tick(2026, 3, 8, 7, 0), "America/New_York") == (4, 6)  # 03:00 EDT: the skipped 02:00 and the real 03:00
    assert due_local_slots(_tick(2026, 3, 8, 7, 30), "America/New_York") == (5, 7)  # 03:30 EDT: the skipped 02:30 and the real 03:30
    assert due_local_slots(_tick(2026, 3, 8, 8, 0), "America/New_York") == (8,)  # back to one slot per tick


def test_a_fall_back_repeated_slot_is_served_once_at_its_first_occurrence():
    # New York, 2026-11-01: 02:00 EDT falls back to 01:00 EST, so 01:00 and 01:30 happen twice. Only the first (EDT) occurrence is a window.
    assert due_local_slots(_tick(2026, 11, 1, 5, 0), "America/New_York") == (2,)  # 01:00 EDT
    assert due_local_slots(_tick(2026, 11, 1, 5, 30), "America/New_York") == (3,)  # 01:30 EDT
    assert due_local_slots(_tick(2026, 11, 1, 6, 0), "America/New_York") == ()  # 01:00 EST: the repeat is not served again
    assert due_local_slots(_tick(2026, 11, 1, 6, 30), "America/New_York") == ()  # 01:30 EST
    assert due_local_slots(_tick(2026, 11, 1, 7, 0), "America/New_York") == (4,)  # 02:00 EST happens once


def test_a_slot_is_due_exactly_when_the_delivery_window_logic_says_its_window_opens():
    # The two code paths must agree on every tick across both 2026 New York transitions: a slot is due at tick T iff T is the first tick
    # at or after the instant next_delivery_window_utc computes for that slot.
    from notifications.notification_dispatch import parse_notification_preference, next_delivery_window_utc

    for slot in (4, 5, 6, 7, 16, 36):
        preference = parse_notification_preference(
            {"enabled": True, "notificationLevel": "all", "notificationTimeZone": "America/New_York", "deliveryWindows": [slot_label(slot)]}
        )
        for start in (_tick(2026, 3, 7, 0), _tick(2026, 10, 31, 0)):
            for index in range(192):
                tick = start + timedelta(minutes=TICK_MINUTES * index)
                opens = next_delivery_window_utc(preference, after=tick - timedelta(minutes=TICK_MINUTES))  # the first window strictly after the previous tick
                assert (slot in due_local_slots(tick, "America/New_York")) == (tick - timedelta(minutes=TICK_MINUTES) < opens <= tick)


def test_a_slot_start_time_is_its_local_wall_clock_start():
    assert slot_start_time(0) == time(0, 0)
    assert slot_start_time(17) == time(8, 30)
    assert slot_start_time(47) == time(23, 30)
    with pytest.raises(ValueError):
        slot_start_time(48)


def test_the_index_key_is_the_zone_and_the_zero_padded_local_slot():
    assert zone_slot_key("Asia/Tokyo", 5) == "Asia/Tokyo|05"
    assert zone_slot_key("America/New_York", 36) == "America/New_York|36"
    with pytest.raises(ValueError):
        zone_slot_key("", 5)
    with pytest.raises(ValueError):
        zone_slot_key("Bad|Zone", 5)
    with pytest.raises(ValueError):
        zone_slot_key(ZONES_PARTITION, 5)  # the registry partition can never be a zone's slot partition
