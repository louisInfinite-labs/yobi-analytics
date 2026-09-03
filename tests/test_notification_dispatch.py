from datetime import datetime, time, timedelta, timezone

import pytest

from notification_dispatch import (
    ClientError,
    NotificationPreference,
    is_creator_enabled,
    is_temporarily_muted,
    is_within_quiet_hours,
    next_delivery_window_utc,
    parse_notification_preference,
    should_notify_now,
)


def _raw_preference(**overrides) -> dict:
    """Build a minimal well-formed raw notification preference dict, overriding only the given fields."""
    fields = {
        "enabled": True,
        "notificationTimeZone": "Asia/Tokyo",
        "deliveryWindows": ["08:00", "18:00"],
    }
    fields.update(overrides)
    return fields


# --- parse_notification_preference ------------------------------------------


def test_parse_notification_preference_accepts_a_minimal_well_formed_dict():
    pref = parse_notification_preference(_raw_preference())

    assert pref.enabled is True
    assert pref.notification_level == "all"
    assert pref.temporary_mute_until is None
    assert pref.creator_overrides == {}
    assert pref.time_zone == "Asia/Tokyo"
    assert pref.delivery_windows == (time(8, 0), time(18, 0))
    assert pref.quiet_hours is None


def test_parse_notification_preference_accepts_a_fully_populated_dict():
    pref = parse_notification_preference(
        _raw_preference(
            notificationLevel="important",
            temporaryMute="2026-09-03T20:00:00+09:00",
            creatorOverride={"aizawa_ema": False, "shirakami_fubuki": True},
            quietHours=["22:00", "07:00"],
        )
    )

    assert pref.notification_level == "important"
    assert pref.temporary_mute_until == datetime(2026, 9, 3, 20, 0, 0, tzinfo=timezone(timedelta(hours=9)))
    assert pref.creator_overrides == {"aizawa_ema": False, "shirakami_fubuki": True}
    assert pref.quiet_hours == (time(22, 0), time(7, 0))


def test_parse_notification_preference_deduplicates_and_sorts_delivery_windows():
    pref = parse_notification_preference(_raw_preference(deliveryWindows=["18:00", "08:00", "08:00"]))
    assert pref.delivery_windows == (time(8, 0), time(18, 0))


@pytest.mark.parametrize("bad_value", [None, "not-a-dict", []])
def test_parse_notification_preference_rejects_a_non_dict(bad_value):
    with pytest.raises(ClientError):
        parse_notification_preference(bad_value)


@pytest.mark.parametrize("bad_value", [None, "yes", 1])
def test_parse_notification_preference_rejects_a_non_boolean_enabled(bad_value):
    with pytest.raises(ClientError):
        parse_notification_preference(_raw_preference(enabled=bad_value))


def test_parse_notification_preference_rejects_an_unsupported_notification_level():
    with pytest.raises(ClientError):
        parse_notification_preference(_raw_preference(notificationLevel="everything"))


def test_parse_notification_preference_rejects_an_unhashable_notification_level():
    """A JSON array/object for notificationLevel must not crash with a raw
    TypeError from the frozenset membership check — it's still just a
    malformed value and should fail the same clean ClientError path."""
    with pytest.raises(ClientError):
        parse_notification_preference(_raw_preference(notificationLevel=[]))


@pytest.mark.parametrize("bad_value", ["not-iso", "2026-09-03T20:00:00"])
def test_parse_notification_preference_rejects_a_malformed_or_naive_temporary_mute(bad_value):
    """A naive (no UTC offset) timestamp is rejected rather than silently
    compared against an aware `now` later, which would raise TypeError."""
    with pytest.raises(ClientError):
        parse_notification_preference(_raw_preference(temporaryMute=bad_value))


@pytest.mark.parametrize(
    "bad_overrides",
    [
        "not-a-dict",
        {"": True},
        {123: True},
        {"aizawa_ema": "off"},
    ],
)
def test_parse_notification_preference_rejects_a_malformed_creator_override(bad_overrides):
    with pytest.raises(ClientError):
        parse_notification_preference(_raw_preference(creatorOverride=bad_overrides))


@pytest.mark.parametrize("bad_value", [None, "", "Not/A_Real_Zone", 123])
def test_parse_notification_preference_rejects_a_malformed_time_zone(bad_value):
    with pytest.raises(ClientError):
        parse_notification_preference(_raw_preference(notificationTimeZone=bad_value))


@pytest.mark.parametrize("bad_value", [None, [], "08:00", [1200], ["25:00"], ["08:00", "8pm"]])
def test_parse_notification_preference_rejects_malformed_delivery_windows(bad_value):
    with pytest.raises(ClientError):
        parse_notification_preference(_raw_preference(deliveryWindows=bad_value))


@pytest.mark.parametrize("bad_value", ["22:00", ["22:00"], ["22:00", "07:00", "12:00"], [1200, "07:00"]])
def test_parse_notification_preference_rejects_malformed_quiet_hours(bad_value):
    with pytest.raises(ClientError):
        parse_notification_preference(_raw_preference(quietHours=bad_value))


# --- is_creator_enabled ----------------------------------------------------


def test_is_creator_enabled_falls_back_to_the_global_flag_when_no_override_exists():
    pref = parse_notification_preference(_raw_preference(enabled=True))
    assert is_creator_enabled(pref, "aizawa_ema") is True

    pref_off = parse_notification_preference(_raw_preference(enabled=False))
    assert is_creator_enabled(pref_off, "aizawa_ema") is False


def test_is_creator_enabled_lets_a_per_creator_override_win_over_the_global_flag():
    pref = parse_notification_preference(_raw_preference(enabled=True, creatorOverride={"aizawa_ema": False}))
    assert is_creator_enabled(pref, "aizawa_ema") is False
    assert is_creator_enabled(pref, "shirakami_fubuki") is True  # no override for this creator


# --- is_temporarily_muted ---------------------------------------------------


def test_is_temporarily_muted_is_false_when_no_mute_is_set():
    pref = parse_notification_preference(_raw_preference())
    assert is_temporarily_muted(pref, now=datetime.now(timezone.utc)) is False


def test_is_temporarily_muted_is_true_before_the_mute_expires():
    pref = parse_notification_preference(_raw_preference(temporaryMute="2026-09-03T20:00:00+00:00"))
    assert is_temporarily_muted(pref, now=datetime(2026, 9, 3, 19, 0, tzinfo=timezone.utc)) is True


def test_is_temporarily_muted_is_false_after_the_mute_expires():
    pref = parse_notification_preference(_raw_preference(temporaryMute="2026-09-03T20:00:00+00:00"))
    assert is_temporarily_muted(pref, now=datetime(2026, 9, 3, 20, 0, 1, tzinfo=timezone.utc)) is False


# --- is_within_quiet_hours ---------------------------------------------------


def test_is_within_quiet_hours_is_false_when_no_quiet_hours_are_set():
    pref = parse_notification_preference(_raw_preference())
    assert is_within_quiet_hours(pref, now=datetime.now(timezone.utc)) is False


def test_is_within_quiet_hours_handles_a_same_day_range():
    pref = parse_notification_preference(_raw_preference(notificationTimeZone="UTC", quietHours=["13:00", "14:00"]))
    assert is_within_quiet_hours(pref, now=datetime(2026, 9, 3, 13, 30, tzinfo=timezone.utc)) is True
    assert is_within_quiet_hours(pref, now=datetime(2026, 9, 3, 12, 59, tzinfo=timezone.utc)) is False
    assert is_within_quiet_hours(pref, now=datetime(2026, 9, 3, 14, 0, tzinfo=timezone.utc)) is False  # end is exclusive


def test_is_within_quiet_hours_handles_a_range_that_wraps_past_midnight():
    pref = parse_notification_preference(_raw_preference(notificationTimeZone="UTC", quietHours=["22:00", "07:00"]))
    assert is_within_quiet_hours(pref, now=datetime(2026, 9, 3, 23, 0, tzinfo=timezone.utc)) is True
    assert is_within_quiet_hours(pref, now=datetime(2026, 9, 4, 6, 0, tzinfo=timezone.utc)) is True
    assert is_within_quiet_hours(pref, now=datetime(2026, 9, 3, 12, 0, tzinfo=timezone.utc)) is False


def test_is_within_quiet_hours_converts_to_the_preferences_own_time_zone():
    # 09:30 JST == 00:30 UTC — inside a 09:00-10:00 JST quiet window even
    # though the UTC wall-clock hour looks nowhere near it.
    pref = parse_notification_preference(_raw_preference(notificationTimeZone="Asia/Tokyo", quietHours=["09:00", "10:00"]))
    assert is_within_quiet_hours(pref, now=datetime(2026, 9, 3, 0, 30, tzinfo=timezone.utc)) is True


# --- should_notify_now -------------------------------------------------------


def test_should_notify_now_is_true_when_nothing_suppresses_it():
    pref = parse_notification_preference(_raw_preference(notificationTimeZone="UTC"))
    assert should_notify_now(pref, "aizawa_ema", now=datetime(2026, 9, 3, 12, 0, tzinfo=timezone.utc)) is True


def test_should_notify_now_is_false_when_the_creator_is_overridden_off():
    pref = parse_notification_preference(_raw_preference(notificationTimeZone="UTC", creatorOverride={"aizawa_ema": False}))
    assert should_notify_now(pref, "aizawa_ema", now=datetime(2026, 9, 3, 12, 0, tzinfo=timezone.utc)) is False


def test_should_notify_now_is_false_while_temporarily_muted():
    pref = parse_notification_preference(
        _raw_preference(notificationTimeZone="UTC", temporaryMute="2026-09-03T23:00:00+00:00")
    )
    assert should_notify_now(pref, "aizawa_ema", now=datetime(2026, 9, 3, 12, 0, tzinfo=timezone.utc)) is False


def test_should_notify_now_is_false_during_quiet_hours():
    pref = parse_notification_preference(_raw_preference(notificationTimeZone="UTC", quietHours=["10:00", "14:00"]))
    assert should_notify_now(pref, "aizawa_ema", now=datetime(2026, 9, 3, 12, 0, tzinfo=timezone.utc)) is False


# --- next_delivery_window_utc -------------------------------------------------


def test_next_delivery_window_utc_picks_the_nearest_later_window_today():
    pref = parse_notification_preference(_raw_preference(notificationTimeZone="UTC", deliveryWindows=["08:00", "18:00"]))
    result = next_delivery_window_utc(pref, after=datetime(2026, 9, 3, 10, 0, tzinfo=timezone.utc))
    assert result == datetime(2026, 9, 3, 18, 0, tzinfo=timezone.utc)


def test_next_delivery_window_utc_rolls_over_to_tomorrows_first_window():
    pref = parse_notification_preference(_raw_preference(notificationTimeZone="UTC", deliveryWindows=["08:00", "18:00"]))
    result = next_delivery_window_utc(pref, after=datetime(2026, 9, 3, 19, 0, tzinfo=timezone.utc))
    assert result == datetime(2026, 9, 4, 8, 0, tzinfo=timezone.utc)


def test_next_delivery_window_utc_converts_a_non_utc_zone_correctly():
    # Asia/Tokyo is UTC+9 with no DST — 08:00 JST is 23:00 UTC the previous day.
    pref = parse_notification_preference(_raw_preference(notificationTimeZone="Asia/Tokyo", deliveryWindows=["08:00"]))
    result = next_delivery_window_utc(pref, after=datetime(2026, 9, 2, 20, 0, tzinfo=timezone.utc))
    assert result == datetime(2026, 9, 2, 23, 0, tzinfo=timezone.utc)


def test_next_delivery_window_utc_is_strictly_after_not_equal():
    pref = parse_notification_preference(_raw_preference(notificationTimeZone="UTC", deliveryWindows=["08:00"]))
    result = next_delivery_window_utc(pref, after=datetime(2026, 9, 3, 8, 0, tzinfo=timezone.utc))
    assert result == datetime(2026, 9, 4, 8, 0, tzinfo=timezone.utc)


def test_next_delivery_window_utc_handles_repeated_hour_during_dst_fallback():
    """During a DST fall-back transition, a wall-clock delivery time recurs
    once at the earlier UTC offset and once at the later one. Naively
    comparing same-zone datetimes ignores this (Python drops `fold` when
    both sides share one tzinfo object), so the first occurrence's actual
    UTC instant — already in the past relative to `after` — must not be
    picked as the "next" window."""
    pref = parse_notification_preference(
        _raw_preference(notificationTimeZone="America/New_York", deliveryWindows=["01:45"])
    )
    # 2026-11-01 06:00 UTC is exactly the fall-back transition (02:00 EDT ->
    # 01:00 EST); 06:30 UTC is 01:30 EST, just after it.
    after = datetime(2026, 11, 1, 6, 30, tzinfo=timezone.utc)

    result = next_delivery_window_utc(pref, after=after)

    assert result > after
    # The correct next window is the following day's 01:45 EST (UTC-5) — not
    # that same day's 01:45 EDT (UTC-4), whose real instant (05:45 UTC) is
    # actually before `after`.
    assert result == datetime(2026, 11, 2, 6, 45, tzinfo=timezone.utc)
