from datetime import datetime, timezone

import pytest

from notifications.live_reminder import (
    ClientError,
    LiveReminderSetting,
    StreamReminderOverride,
    StreamScheduleEntry,
    is_advance_reminder_due,
    is_start_reminder_due,
    parse_creator_live_reminders,
    parse_stream_notification_overrides,
    parse_stream_schedule_snapshot,
    resolve_effective_setting,
)

# --- parsing ------------------------------------------------------------


def test_parse_creator_live_reminders_accepts_start_and_advance():
    result = parse_creator_live_reminders({"aizawa_ema": {"notifyAtStart": True, "advanceReminder": "30min"}})
    assert result == {"aizawa_ema": LiveReminderSetting(notify_at_start=True, advance_reminder="30min")}


def test_parse_creator_live_reminders_accepts_null_advance_reminder():
    result = parse_creator_live_reminders({"aizawa_ema": {"notifyAtStart": True, "advanceReminder": None}})
    assert result["aizawa_ema"].advance_reminder is None


@pytest.mark.parametrize("bad_value", [None, "not-a-dict", []])
def test_parse_creator_live_reminders_rejects_a_non_dict(bad_value):
    with pytest.raises(ClientError):
        parse_creator_live_reminders(bad_value)


def test_parse_creator_live_reminders_rejects_an_unsupported_advance_value():
    with pytest.raises(ClientError):
        parse_creator_live_reminders({"aizawa_ema": {"notifyAtStart": True, "advanceReminder": "2hours"}})


def test_parse_stream_notification_overrides_accepts_a_well_formed_entry():
    """An override is notification preference only -- it has no
    scheduledStartMs of its own (that always comes from the system-wide
    streamSchedule snapshot instead, so a reschedule is never stale)."""
    result = parse_stream_notification_overrides({"v1": {"creatorId": "aizawa_ema", "notifyAtStart": True, "advanceReminder": "1hour"}})
    assert result == {"v1": StreamReminderOverride(creator_id="aizawa_ema", setting=LiveReminderSetting(notify_at_start=True, advance_reminder="1hour"))}


def test_parse_stream_notification_overrides_ignores_a_stray_legacy_scheduled_start_field():
    """A record saved before this change may still carry an old
    scheduledStartMs key -- it's simply ignored, not rejected, so an
    existing stored override doesn't suddenly fail to parse."""
    result = parse_stream_notification_overrides(
        {"v1": {"creatorId": "aizawa_ema", "scheduledStartMs": 1000, "notifyAtStart": True, "advanceReminder": "1hour"}}
    )
    assert result == {"v1": StreamReminderOverride(creator_id="aizawa_ema", setting=LiveReminderSetting(notify_at_start=True, advance_reminder="1hour"))}


def test_parse_stream_schedule_snapshot_accepts_entries_and_refreshed_at():
    snapshot = parse_stream_schedule_snapshot(
        {"entries": {"v1": {"creatorId": "aizawa_ema", "scheduledStartMs": 1000}}, "refreshedAt": "2026-01-01T00:00:00+00:00"}
    )
    assert snapshot.entries == {"v1": StreamScheduleEntry(creator_id="aizawa_ema", scheduled_start_ms=1000)}
    assert snapshot.refreshed_at == datetime(2026, 1, 1, tzinfo=timezone.utc)


def test_parse_stream_schedule_snapshot_rejects_a_missing_refreshed_at():
    with pytest.raises(ClientError):
        parse_stream_schedule_snapshot({"entries": {}})


def test_parse_stream_schedule_snapshot_rejects_a_refreshed_at_without_a_utc_offset():
    """A naive timestamp can't be compared with the dispatcher's timezone-aware
    "now" (TypeError), so it must be rejected here and treated as an absent snapshot."""
    with pytest.raises(ClientError):
        parse_stream_schedule_snapshot({"entries": {}, "refreshedAt": "2026-01-01T00:00:00"})


# --- resolve_effective_setting (spec section 4) --------------------------


def test_resolve_falls_back_to_creator_recurring_setting_when_no_override_exists():
    creator_reminders = {"aizawa_ema": LiveReminderSetting(notify_at_start=True, advance_reminder="30min")}
    effective = resolve_effective_setting(
        video_id="stream_b", creator_id="aizawa_ema", stream_overrides={}, creator_reminders=creator_reminders
    )
    assert effective == LiveReminderSetting(notify_at_start=True, advance_reminder="30min")


def test_resolve_prefers_stream_override_and_does_not_merge_with_creator_setting():
    """Worked example from the spec: creator=start+30min, Stream A override=start+1hour
    must resolve to exactly start+1hour, never "1hour and 30min and start"."""
    creator_reminders = {"aizawa_ema": LiveReminderSetting(notify_at_start=True, advance_reminder="30min")}
    stream_overrides = {
        "stream_a": StreamReminderOverride(creator_id="aizawa_ema", setting=LiveReminderSetting(notify_at_start=True, advance_reminder="1hour"))
    }
    effective = resolve_effective_setting(
        video_id="stream_a", creator_id="aizawa_ema", stream_overrides=stream_overrides, creator_reminders=creator_reminders
    )
    assert effective == LiveReminderSetting(notify_at_start=True, advance_reminder="1hour")


def test_resolve_falls_back_to_default_when_neither_override_nor_creator_setting_exists():
    effective = resolve_effective_setting(video_id="v1", creator_id="unknown_creator", stream_overrides={}, creator_reminders={})
    assert effective == LiveReminderSetting(notify_at_start=True, advance_reminder=None)


# --- is_advance_reminder_due / is_start_reminder_due ----------------------


def test_advance_reminder_due_uses_scheduled_start_not_discovery_time():
    setting = LiveReminderSetting(notify_at_start=True, advance_reminder="30min")
    scheduled_start_ms = 1_000_000_000_000
    fire_at = scheduled_start_ms - 30 * 60_000
    assert is_advance_reminder_due(setting, scheduled_start_ms, now_ms=fire_at, window_ms=15 * 60_000) is True
    assert is_advance_reminder_due(setting, scheduled_start_ms, now_ms=fire_at - 1, window_ms=15 * 60_000) is False
    assert is_advance_reminder_due(setting, scheduled_start_ms, now_ms=fire_at + 15 * 60_000, window_ms=15 * 60_000) is False


def test_advance_reminder_not_due_when_setting_has_no_advance_reminder():
    setting = LiveReminderSetting(notify_at_start=True, advance_reminder=None)
    assert is_advance_reminder_due(setting, 1_000_000, now_ms=1_000_000, window_ms=900_000) is False


def test_start_reminder_due_window():
    setting = LiveReminderSetting(notify_at_start=True, advance_reminder="1hour")
    scheduled_start_ms = 2_000_000_000_000
    assert is_start_reminder_due(setting, scheduled_start_ms, now_ms=scheduled_start_ms, window_ms=900_000) is True
    assert is_start_reminder_due(setting, scheduled_start_ms, now_ms=scheduled_start_ms - 1, window_ms=900_000) is False


def test_start_and_advance_can_both_be_due_at_their_own_respective_windows_independently():
    """Spec section 1/8: these are independent, both-can-apply dimensions, not mutually exclusive."""
    setting = LiveReminderSetting(notify_at_start=True, advance_reminder="30min")
    scheduled_start_ms = 1_000_000_000_000
    advance_fire_at = scheduled_start_ms - 30 * 60_000
    assert is_advance_reminder_due(setting, scheduled_start_ms, now_ms=advance_fire_at, window_ms=900_000) is True
    assert is_start_reminder_due(setting, scheduled_start_ms, now_ms=advance_fire_at, window_ms=900_000) is False
    assert is_advance_reminder_due(setting, scheduled_start_ms, now_ms=scheduled_start_ms, window_ms=900_000) is False
    assert is_start_reminder_due(setting, scheduled_start_ms, now_ms=scheduled_start_ms, window_ms=900_000) is True
