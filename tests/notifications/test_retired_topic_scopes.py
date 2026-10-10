"""A notification category retired from the V1 catalog (GTA, 7 Days to Die, Mahjong Soul, Endfield) can never cause a delivery.

What the backend actually stores for a category is limited, and both stores already refuse a retired id:
- a creator + topic REMINDER item is keyed by topic id; the scope must be a canonical backend topic (live_reminder.REMINDER_TOPIC_IDS), so a
  retired scope can neither be written (400) nor, if an old item still exists, be read -- it is skipped and reported;
- NEW-VIDEO eligibility stores no topic id at all (only per-creator switches and, separately, the Short members), so there is no retired
  id to honour there; a stale per-creator flag is cleaned by the frontend's one-time re-sync (see useRetiredTopicResync).
These tests pin the backend half: stale retired scopes in a persisted document are ignored and never replayed, and nothing valid is lost.
"""

from __future__ import annotations

import pytest

from notifications import live_reminder, notification_dispatcher
from notifications.notification_dispatch import parse_notification_preference

from tests.notifications.test_notification_dispatcher import (
    _DAY1_EVENING,
    _STORED_REMINDER_ITEMS,
    _event_item,
    _fake_delivery_log,
    _preference_value,
    _run_new_video_pass,
    # The dispatcher module's autouse fixtures (no real VAPID / Holodex / remote-config access).
    stub_creators,  # noqa: F401
    stub_live_streams,  # noqa: F401
    stub_reminder_items,  # noqa: F401
    stub_vapid,  # noqa: F401
)

RETIRED = ["gta", "seven_days_to_die", "mahjong_soul", "endfield"]
SETTING = {"notifyAtStart": True, "advanceReminder": "10min"}
START_MS = 1_800_000_000_000


def _key(creator_id: str, scope: str) -> str:
    return f"creatorReminder#{creator_id}#{scope}"


def _resolve(streams: dict[str, live_reminder.StreamScheduleEntry]) -> dict:
    return notification_dispatcher._resolve_reminders_for_client("c1", streams)


def _stream(topic: str | None, creator_id: str = "aizawa_ema") -> live_reminder.StreamScheduleEntry:
    return live_reminder.StreamScheduleEntry(creator_id=creator_id, scheduled_start_ms=START_MS, topic=topic)


@pytest.mark.parametrize("retired", RETIRED)
def test_a_retired_scope_can_no_longer_be_written(retired):
    with pytest.raises(live_reminder.ClientError):
        live_reminder.creator_reminder_key("aizawa_ema", retired)


def test_a_stale_reminder_item_that_only_has_a_retired_scope_resolves_to_nothing():
    _STORED_REMINDER_ITEMS[_key("aizawa_ema", "gta")] = SETTING

    resolved = _resolve({"v1": _stream("valorant"), "v2": _stream(None)})

    assert resolved == {}


def test_a_valid_valorant_reminder_still_works_next_to_a_stale_retired_one():
    _STORED_REMINDER_ITEMS[_key("aizawa_ema", "valorant")] = SETTING
    _STORED_REMINDER_ITEMS[_key("aizawa_ema", "gta")] = {"notifyAtStart": True, "advanceReminder": "1hour"}

    resolved = _resolve({"v1": _stream("valorant")})

    assert set(resolved) == {"v1"}
    assert resolved["v1"].setting.advance_reminder == "10min"  # VALO's own setting, never the retired item's


def test_every_retired_scope_is_ignored_together_and_reported_not_applied():
    for retired in RETIRED:
        _STORED_REMINDER_ITEMS[_key("aizawa_ema", retired)] = SETTING
    _STORED_REMINDER_ITEMS[_key("aizawa_ema", "sf6")] = SETTING

    records = [{"key": key, "value": value} for key, value in _STORED_REMINDER_ITEMS.items()]
    settings = live_reminder.parse_reminder_settings(records, [])

    assert settings.creator_topics == {("aizawa_ema", "sf6"): live_reminder.parse_live_reminder_setting(SETTING, context="t")}
    assert sorted(settings.invalid_keys) == sorted(_key("aizawa_ema", retired) for retired in RETIRED)
    assert set(_resolve({"v1": _stream("sf6"), "v2": _stream("valorant")})) == {"v1"}


def test_the_creator_wide_reminder_is_unaffected_by_a_stale_retired_item():
    _STORED_REMINDER_ITEMS[_key("aizawa_ema", "all")] = {"notifyAtStart": True, "advanceReminder": "30min"}
    _STORED_REMINDER_ITEMS[_key("aizawa_ema", "endfield")] = SETTING

    resolved = _resolve({"v1": _stream("valorant"), "v2": _stream(None)})

    assert {video_id: reminder.setting.advance_reminder for video_id, reminder in resolved.items()} == {"v1": "30min", "v2": "30min"}


def test_deleting_the_stale_item_later_never_creates_a_reminder_that_was_ignored_before():
    _STORED_REMINDER_ITEMS[_key("aizawa_ema", "gta")] = SETTING
    assert _resolve({"v1": _stream("valorant")}) == {}

    _STORED_REMINDER_ITEMS.clear()
    assert _resolve({"v1": _stream("valorant")}) == {}  # nothing queued up behind it: no replay


def test_the_short_preference_is_unaffected_by_retired_scopes():
    _STORED_REMINDER_ITEMS[_key("aizawa_ema", "mahjong_soul")] = SETTING
    pref = parse_notification_preference(
        {
            "enabled": True, "notificationLevel": "all", "notificationTimeZone": "Asia/Tokyo", "deliveryWindows": ["08:00", "18:00"],
            "newVideoShortCreatorOverride": {"aizawa_ema": True},
        }
    )

    assert pref.new_video_short_creator_overrides == {"aizawa_ema": True}
    assert _resolve({"v1": _stream("valorant")}) == {}


def test_new_video_eligibility_ignores_retired_scopes_and_follows_the_creator_switch_as_before(monkeypatch):
    # A preference document with leftovers of the retired categories under keys the backend does not know about, and a stale retired reminder.
    _STORED_REMINDER_ITEMS[_key("aizawa_ema", "gta")] = SETTING
    stale = _preference_value(newVideoTopicOverride={"gta": True, "endfield": False}, newVideoCreatorOverride={"aizawa_ema": True})
    _fake_delivery_log(monkeypatch)

    assert _run_new_video_pass(monkeypatch, now=_DAY1_EVENING, preference=stale, event=_event_item(eventDate="2026-09-02", discoveredAt="2026-09-02T18:00:00+09:00")) == [{"videoId": "v1"}]

    _fake_delivery_log(monkeypatch)
    off = _preference_value(newVideoTopicOverride={"gta": True}, newVideoCreatorOverride={"aizawa_ema": False})
    assert _run_new_video_pass(monkeypatch, now=_DAY1_EVENING, preference=off, event=_event_item(eventDate="2026-09-02", discoveredAt="2026-09-02T18:00:00+09:00")) == []
