"""Per-creator NEW-VIDEO switch (preference field `newVideoCreatorOverride`).

The Settings 新片 switches write this map through the existing PUT notification-preference route. It must:
- suppress only that creator's new-video pushes (never live reminders, which the reminder settings govern),
- sit BELOW the global master switch (global OFF beats everything) and ABOVE nothing else (mute/quiet hours
  still suppress),
- never replay: an event that came due while the creator was OFF stays suppressed when the creator is turned
  back ON (same policy as the global master switch),
- default to enabled for any creator without an entry (existing stored preferences keep working).
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from notifications.notification_dispatch import (
    ClientError,
    is_new_video_creator_enabled,
    parse_notification_preference,
    should_notify_now,
)

from tests.notifications.test_notification_dispatcher import (
    _DAY1_EVENING,
    _DAY2_EVENING,
    _fake_delivery_log,
    _preference_value,
    _run_new_video_pass,
    # The dispatcher module's autouse fixtures (no real VAPID / Holodex / remote-config access); importing them
    # by name makes pytest apply them to this module too.
    stub_creators,  # noqa: F401
    stub_live_streams,  # noqa: F401
    stub_reminder_items,  # noqa: F401
    stub_vapid,  # noqa: F401
)


def _raw(**overrides) -> dict:
    """A minimal valid stored preference, overridden per test."""
    fields = {
        "enabled": True,
        "notificationLevel": "all",
        "notificationTimeZone": "Asia/Tokyo",
        "deliveryWindows": ["08:00", "18:00"],
    }
    fields.update(overrides)
    return fields


# --- parsing -----------------------------------------------------------------


def test_a_preference_without_the_field_has_no_new_video_overrides():
    assert parse_notification_preference(_raw()).new_video_creator_overrides == {}


def test_the_field_is_parsed_into_the_preference():
    pref = parse_notification_preference(_raw(newVideoCreatorOverride={"aizawa_ema": False, "shirakami_fubuki": True}))

    assert pref.new_video_creator_overrides == {"aizawa_ema": False, "shirakami_fubuki": True}


def test_it_is_independent_of_the_general_creator_override():
    pref = parse_notification_preference(
        _raw(creatorOverride={"aizawa_ema": True}, newVideoCreatorOverride={"aizawa_ema": False})
    )

    assert pref.creator_overrides == {"aizawa_ema": True}
    assert pref.new_video_creator_overrides == {"aizawa_ema": False}


@pytest.mark.parametrize(
    "bad",
    [[], "aizawa_ema", {"aizawa_ema": "no"}, {"aizawa_ema": 0}, {"aizawa_ema": None}, {"": True}, {1: True}],
)
def test_a_malformed_field_is_a_client_error(bad):
    with pytest.raises(ClientError):
        parse_notification_preference(_raw(newVideoCreatorOverride=bad))


# --- decision ----------------------------------------------------------------


def test_only_an_explicit_false_disables_a_creators_new_video_pushes():
    pref = parse_notification_preference(_raw(newVideoCreatorOverride={"aizawa_ema": False, "shirakami_fubuki": True}))

    assert is_new_video_creator_enabled(pref, "aizawa_ema") is False
    assert is_new_video_creator_enabled(pref, "shirakami_fubuki") is True
    assert is_new_video_creator_enabled(pref, "someone_without_an_entry") is True


def test_a_new_video_off_creator_still_passes_the_general_gate_so_live_reminders_are_unaffected():
    """should_notify_now (used by reminders too) does not read the new-video map."""
    pref = parse_notification_preference(_raw(newVideoCreatorOverride={"aizawa_ema": False}))
    now = datetime(2026, 9, 3, 9, 5, tzinfo=timezone.utc)

    assert should_notify_now(pref, "aizawa_ema", now=now) is True


# --- dispatcher delivery -----------------------------------------------------


@pytest.mark.parametrize(
    ("global_enabled", "new_video_override", "expect_sent"),
    [
        (True, None, True),  # no entry: default allowed
        (True, True, True),
        (True, False, False),  # global ON + creator new-video OFF: suppressed
        (False, None, False),  # global OFF beats everything
        (False, True, False),
        (False, False, False),
    ],
)
def test_new_video_delivery_follows_the_global_switch_and_the_creators_new_video_switch(
    monkeypatch, global_enabled, new_video_override, expect_sent
):
    _fake_delivery_log(monkeypatch)
    overrides = {} if new_video_override is None else {"aizawa_ema": new_video_override}
    preference = _preference_value(enabled=global_enabled, newVideoCreatorOverride=overrides)

    sent = _run_new_video_pass(monkeypatch, now=_DAY1_EVENING, preference=preference)

    assert (sent == [{"videoId": "v1"}]) is expect_sent


def test_another_creators_off_switch_does_not_suppress_this_creator(monkeypatch):
    _fake_delivery_log(monkeypatch)
    preference = _preference_value(newVideoCreatorOverride={"shirakami_fubuki": False})

    sent = _run_new_video_pass(monkeypatch, now=_DAY1_EVENING, preference=preference)

    assert sent == [{"videoId": "v1"}]


def test_the_general_creator_override_still_applies_alongside_the_new_video_map(monkeypatch):
    _fake_delivery_log(monkeypatch)
    preference = _preference_value(creatorOverride={"aizawa_ema": False}, newVideoCreatorOverride={"aizawa_ema": True})

    sent = _run_new_video_pass(monkeypatch, now=_DAY1_EVENING, preference=preference)

    assert sent == []


def test_an_event_that_came_due_while_the_creator_was_off_is_not_replayed_when_turned_back_on(monkeypatch):
    rows = _fake_delivery_log(monkeypatch)

    off = _run_new_video_pass(
        monkeypatch, now=_DAY1_EVENING, preference=_preference_value(newVideoCreatorOverride={"aizawa_ema": False})
    )
    assert off == []
    assert rows == {("c1", "v1"): "suppressed"}

    on = _run_new_video_pass(
        monkeypatch, now=_DAY2_EVENING, preference=_preference_value(newVideoCreatorOverride={"aizawa_ema": True})
    )
    assert on == []


def test_mute_still_suppresses_a_new_video_enabled_creator_without_recording_it(monkeypatch):
    rows = _fake_delivery_log(monkeypatch)
    preference = _preference_value(
        newVideoCreatorOverride={"aizawa_ema": True}, temporaryMute="2026-09-03T10:00:00+00:00"
    )

    sent = _run_new_video_pass(monkeypatch, now=_DAY1_EVENING, preference=preference)

    assert sent == []
    assert rows == {}  # mute is not a permanent skip: delivered later once it ends
