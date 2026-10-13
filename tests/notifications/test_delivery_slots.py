from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

import pytest

from notifications.delivery_slots import (
    MAX_SLOTS_PER_CLIENT,
    SLOTS_PER_DAY,
    InvalidDeliverySlotsError,
    floor_to_tick,
    jst_slot,
    normalize_stored_slots,
    parse_slot_label,
    parse_strict_slots,
    slot_key,
    slot_label,
    slot_of_time,
    slot_start_time,
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
        slot_key(slot)


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
        (datetime(2026, 9, 3, 9, 29, 59, 999999, tzinfo=timezone.utc), "2026-09-03T09:00:00+00:00"),
        (datetime(2026, 9, 3, 9, 30, 1, tzinfo=timezone.utc), "2026-09-03T09:30:00+00:00"),
        (datetime(2026, 9, 3, 18, 40, tzinfo=timezone.utc).astimezone(ZoneInfo("Asia/Tokyo")), "2026-09-03T18:30:00+00:00"),  # any zone in, UTC out
    ],
)
def test_a_tick_is_the_utc_half_hour_at_or_before_the_instant(instant, expected):
    assert floor_to_tick(instant).isoformat() == expected


@pytest.mark.parametrize(
    ("tick", "expected"),
    [
        (datetime(2026, 9, 3, 9, 0, tzinfo=timezone.utc), 36),  # 18:00 JST
        (datetime(2026, 9, 3, 9, 30, tzinfo=timezone.utc), 37),  # 18:30 JST
        (datetime(2026, 9, 2, 15, 0, tzinfo=timezone.utc), 0),  # 00:00 JST, the next JST day
        (datetime(2026, 9, 2, 14, 30, tzinfo=timezone.utc), 47),  # 23:30 JST
        (datetime(2026, 9, 3, 23, 0, tzinfo=timezone.utc), 16),  # 08:00 JST
    ],
)
def test_a_tick_is_the_start_of_one_jst_slot_whatever_zone_it_is_expressed_in(tick, expected):
    assert jst_slot(tick) == expected
    assert jst_slot(tick.astimezone(ZoneInfo("America/New_York"))) == expected
    assert jst_slot(tick.astimezone(ZoneInfo("Asia/Kathmandu"))) == expected


def test_jst_has_no_daylight_saving_so_a_given_utc_tick_maps_to_the_same_slot_all_year():
    summer = datetime(2026, 7, 15, 9, 0, tzinfo=timezone.utc)
    winter = datetime(2026, 1, 15, 9, 0, tzinfo=timezone.utc)

    assert jst_slot(summer) == jst_slot(winter) == 36


def test_every_utc_half_hour_tick_is_exactly_the_start_of_one_jst_slot():
    day = datetime(2026, 9, 3, 0, 0, tzinfo=timezone.utc)
    slots = [jst_slot(day.replace(hour=hour, minute=minute)) for hour in range(24) for minute in (0, 30)]

    assert sorted(slots) == list(range(SLOTS_PER_DAY))


def test_a_slot_start_time_is_its_jst_wall_clock_start():
    assert slot_start_time(0) == time(0, 0)
    assert slot_start_time(17) == time(8, 30)
    assert slot_start_time(47) == time(23, 30)
    with pytest.raises(ValueError):
        slot_start_time(48)


def test_the_slot_key_is_the_zero_padded_jst_slot():
    assert slot_key(5) == "05"
    assert slot_key(36) == "36"
