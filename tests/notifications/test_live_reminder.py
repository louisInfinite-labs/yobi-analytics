from datetime import datetime, timezone

import pytest

from notifications.live_reminder import (
    ClientError,
    LiveReminderSetting,
    ReminderSettings,
    StreamReminderOverride,
    StreamScheduleEntry,
    advance_reminder_fire_at_ms,
    creator_reminder_key,
    is_advance_reminder_due,
    is_start_reminder_due,
    parse_live_reminder_setting,
    parse_reminder_scope,
    parse_reminder_settings,
    parse_stream_override,
    parse_stream_schedule_snapshot,
    resolve_effective_setting,
    stream_override_key,
)


def _setting(advance: str | None = None, *, start: bool = True) -> LiveReminderSetting:
    return LiveReminderSetting(notify_at_start=start, advance_reminder=advance)


def _record(key: str, value: dict) -> dict:
    return {"clientId": "c1", "key": key, "value": value, "updatedAt": "2026-01-01T00:00:00+00:00"}


def _setting_value(advance: str | None = None) -> dict:
    return {"notifyAtStart": True, "advanceReminder": advance}


# --- keys and scopes ----------------------------------------------------


def test_creator_reminder_key_uses_one_item_per_creator_and_scope():
    assert creator_reminder_key("aizawa_ema", "all") == "creatorReminder#aizawa_ema#all"
    assert creator_reminder_key("aizawa_ema", "sf6") == "creatorReminder#aizawa_ema#sf6"
    assert creator_reminder_key("aizawa_ema", "singing") == "creatorReminder#aizawa_ema#singing"


def test_stream_override_key_is_one_item_per_stream():
    assert stream_override_key("v1") == "streamOverride#v1"


@pytest.mark.parametrize("scope", ["all", "valorant", "sf6", "apex", "minecraft", "singing", "mv", "chatting"])
def test_scope_accepts_all_and_every_canonical_backend_topic(scope):
    assert parse_reminder_scope(scope) == scope


@pytest.mark.parametrize("scope", ["valo", "gta", "other", "", None, 5])
def test_scope_rejects_non_canonical_ids_and_the_other_fallback(scope):
    with pytest.raises(ClientError):
        parse_reminder_scope(scope)


@pytest.mark.parametrize("creator_id", ["", "a#b", None])
def test_creator_reminder_key_rejects_an_empty_or_ambiguous_creator_id(creator_id):
    with pytest.raises(ClientError):
        creator_reminder_key(creator_id, "all")


def test_stream_override_key_rejects_an_ambiguous_video_id():
    with pytest.raises(ClientError):
        stream_override_key("a#b")


# --- parsing one setting ------------------------------------------------


def test_parse_setting_accepts_start_and_advance():
    assert parse_live_reminder_setting({"notifyAtStart": True, "advanceReminder": "30min"}) == _setting("30min")


def test_parse_setting_accepts_null_advance_reminder_as_at_start():
    assert parse_live_reminder_setting({"notifyAtStart": True, "advanceReminder": None}).advance_reminder is None


@pytest.mark.parametrize("bad_value", [None, "not-a-dict", []])
def test_parse_setting_rejects_a_non_dict(bad_value):
    with pytest.raises(ClientError):
        parse_live_reminder_setting(bad_value)


def test_parse_setting_rejects_an_unsupported_advance_value():
    with pytest.raises(ClientError):
        parse_live_reminder_setting({"notifyAtStart": True, "advanceReminder": "2hours"})


def test_parse_stream_override_is_notification_preference_only_and_ignores_a_stray_scheduled_start():
    """An override has no scheduledStartMs of its own (that always comes from
    the system-wide streamSchedule snapshot, so a reschedule is never stale)."""
    result = parse_stream_override(
        {"creatorId": "aizawa_ema", "scheduledStartMs": 1000, "notifyAtStart": True, "advanceReminder": "1hour"}
    )
    assert result == StreamReminderOverride(creator_id="aizawa_ema", setting=_setting("1hour"))


def test_parse_stream_override_requires_a_creator_id():
    with pytest.raises(ClientError):
        parse_stream_override({"notifyAtStart": True, "advanceReminder": "1hour"})


# --- parsing a client's stored items -----------------------------------


def test_parse_reminder_settings_sorts_items_into_all_topic_and_stream_levels():
    settings = parse_reminder_settings(
        [
            _record("creatorReminder#ema#all", _setting_value("30min")),
            _record("creatorReminder#ema#sf6", _setting_value("10min")),
            _record("creatorReminder#ema#singing", _setting_value("1hour")),
        ],
        [_record("streamOverride#v1", {"creatorId": "ema", **_setting_value("1min")})],
    )

    assert settings.creator_all == {"ema": _setting("30min")}
    assert settings.creator_topics == {("ema", "sf6"): _setting("10min"), ("ema", "singing"): _setting("1hour")}
    assert settings.stream_overrides == {"v1": StreamReminderOverride(creator_id="ema", setting=_setting("1min"))}
    assert settings.invalid_keys == ()


def test_parse_reminder_settings_skips_only_the_malformed_items_and_reports_them():
    settings = parse_reminder_settings(
        [
            _record("creatorReminder#ema#all", _setting_value("30min")),
            _record("creatorReminder#ema#gta", _setting_value("10min")),  # not a canonical topic
            _record("creatorReminder#ema#sf6", {"notifyAtStart": "yes"}),  # bad value
            _record("creatorReminder#ema", _setting_value("10min")),  # malformed key
        ],
        [_record("streamOverride#v1", {"notifyAtStart": True, "advanceReminder": None})],  # no creatorId
    )

    assert settings.creator_all == {"ema": _setting("30min")}
    assert settings.creator_topics == {}
    assert settings.stream_overrides == {}
    assert set(settings.invalid_keys) == {
        "creatorReminder#ema#gta",
        "creatorReminder#ema#sf6",
        "creatorReminder#ema",
        "streamOverride#v1",
    }


# --- parsing the schedule snapshot -------------------------------------


def test_parse_stream_schedule_snapshot_accepts_entries_topic_and_refreshed_at():
    snapshot = parse_stream_schedule_snapshot(
        {
            "entries": {
                "v1": {"creatorId": "aizawa_ema", "scheduledStartMs": 1000, "topic": "sf6"},
                "v2": {"creatorId": "aizawa_ema", "scheduledStartMs": 2000, "topic": None},
            },
            "refreshedAt": "2026-01-01T00:00:00+00:00",
        }
    )
    assert snapshot.entries == {
        "v1": StreamScheduleEntry(creator_id="aizawa_ema", scheduled_start_ms=1000, topic="sf6"),
        "v2": StreamScheduleEntry(creator_id="aizawa_ema", scheduled_start_ms=2000, topic=None),
    }
    assert snapshot.refreshed_at == datetime(2026, 1, 1, tzinfo=timezone.utc)


def test_parse_stream_schedule_snapshot_treats_a_missing_topic_as_none():
    """A snapshot persisted before topics were tracked has no topic key."""
    snapshot = parse_stream_schedule_snapshot(
        {"entries": {"v1": {"creatorId": "aizawa_ema", "scheduledStartMs": 1000}}, "refreshedAt": "2026-01-01T00:00:00+00:00"}
    )
    assert snapshot.entries["v1"].topic is None


@pytest.mark.parametrize("topic", ["valo", "other", 5])
def test_parse_stream_schedule_snapshot_rejects_a_non_canonical_topic(topic):
    with pytest.raises(ClientError):
        parse_stream_schedule_snapshot(
            {
                "entries": {"v1": {"creatorId": "aizawa_ema", "scheduledStartMs": 1000, "topic": topic}},
                "refreshedAt": "2026-01-01T00:00:00+00:00",
            }
        )


def test_parse_stream_schedule_snapshot_rejects_a_missing_refreshed_at():
    with pytest.raises(ClientError):
        parse_stream_schedule_snapshot({"entries": {}})


def test_parse_stream_schedule_snapshot_rejects_a_refreshed_at_without_a_utc_offset():
    """A naive timestamp can't be compared with the dispatcher's timezone-aware
    "now" (TypeError), so it must be rejected here and treated as an absent snapshot."""
    with pytest.raises(ClientError):
        parse_stream_schedule_snapshot({"entries": {}, "refreshedAt": "2026-01-01T00:00:00"})


# --- resolve_effective_setting: stream override > 全部 > creator+topic > unset ---


def _ema_settings(*, all_: str | None = None, sf6: str | None = None, singing: str | None = None) -> ReminderSettings:
    """エマ's settings: an optional 全部 plus optional SF6 / 歌回 topic settings."""
    topics = {}
    if sf6 is not None:
        topics[("ema", "sf6")] = _setting(sf6)
    if singing is not None:
        topics[("ema", "singing")] = _setting(singing)
    return ReminderSettings(creator_all={"ema": _setting(all_)} if all_ is not None else {}, creator_topics=topics)


def _resolve(settings: ReminderSettings, *, video_id="v1", creator_id="ema", topic: str | None = None):
    return resolve_effective_setting(video_id=video_id, creator_id=creator_id, topic=topic, settings=settings)


def test_topic_setting_applies_when_creator_all_is_unset():
    settings = _ema_settings(sf6="10min")
    assert _resolve(settings, topic="sf6") == _setting("10min")


def test_creator_all_shadows_every_topic_including_unmatched_and_topicless_streams():
    """エマ 全部=30m, SF6=10m, 歌回=1h: SF6, 歌回 and any other stream all use 30m."""
    settings = _ema_settings(all_="30min", sf6="10min", singing="1hour")

    assert _resolve(settings, topic="sf6") == _setting("30min")
    assert _resolve(settings, topic="singing") == _setting("30min")
    assert _resolve(settings, topic="minecraft") == _setting("30min")
    assert _resolve(settings, topic=None) == _setting("30min")


def test_unsetting_creator_all_makes_the_untouched_topic_settings_take_effect_again():
    """Same settings as above, 全部 removed: SF6 -> 10m, 歌回 -> 1h, unmatched -> none."""
    with_all = _ema_settings(all_="30min", sf6="10min", singing="1hour")
    without_all = ReminderSettings(creator_all={}, creator_topics=with_all.creator_topics)

    assert _resolve(without_all, topic="sf6") == _setting("10min")
    assert _resolve(without_all, topic="singing") == _setting("1hour")
    assert _resolve(without_all, topic="minecraft") is None
    assert _resolve(without_all, topic=None) is None


def test_resolving_never_modifies_the_shadowed_topic_settings():
    settings = _ema_settings(all_="30min", sf6="10min", singing="1hour")
    topics_before = dict(settings.creator_topics)

    _resolve(settings, topic="sf6")
    _resolve(settings, topic="singing")

    assert settings.creator_topics == topics_before
    assert settings.creator_all == {"ema": _setting("30min")}


def test_a_stream_override_beats_creator_all_and_topic_without_merging():
    """エマ 全部=30m, SF6=10m, this one stream=1h -> exactly 1h for that stream;
    the next SF6 stream without an override -> 30m; with 全部 unset -> 10m."""
    settings = ReminderSettings(
        creator_all={"ema": _setting("30min")},
        creator_topics={("ema", "sf6"): _setting("10min")},
        stream_overrides={"stream_a": StreamReminderOverride(creator_id="ema", setting=_setting("1hour"))},
    )

    assert _resolve(settings, video_id="stream_a", topic="sf6") == _setting("1hour")
    assert _resolve(settings, video_id="stream_b", topic="sf6") == _setting("30min")

    without_all = ReminderSettings(creator_topics=settings.creator_topics)
    assert _resolve(without_all, video_id="stream_b", topic="sf6") == _setting("10min")


def test_a_stream_override_applies_only_to_its_own_stream():
    settings = ReminderSettings(stream_overrides={"stream_a": StreamReminderOverride(creator_id="ema", setting=_setting("1hour"))})

    assert _resolve(settings, video_id="stream_a") == _setting("1hour")
    assert _resolve(settings, video_id="stream_b") is None


def test_unset_means_no_reminder_never_a_default():
    assert _resolve(ReminderSettings(), topic="sf6") is None
    assert _resolve(ReminderSettings(), topic=None) is None


def test_creators_are_resolved_independently():
    settings = ReminderSettings(
        creator_all={"ema": _setting("30min")},
        creator_topics={("ema", "sf6"): _setting("10min"), ("other_creator", "sf6"): _setting("1hour")},
    )

    assert _resolve(settings, creator_id="other_creator", topic="sf6") == _setting("1hour")
    assert _resolve(settings, creator_id="third_creator", topic="sf6") is None


def test_at_start_is_a_setting_and_still_shadows_a_topic_reminder():
    """at_start (notify only at start) is a real value, distinct from unset."""
    settings = ReminderSettings(creator_all={"ema": _setting(None)}, creator_topics={("ema", "sf6"): _setting("10min")})

    assert _resolve(settings, topic="sf6") == _setting(None)


# --- fire times and due windows ----------------------------------------


def test_advance_fire_time_is_start_minus_offset_or_none():
    assert advance_reminder_fire_at_ms(_setting("30min"), 1_000_000_000_000) == 1_000_000_000_000 - 30 * 60_000
    assert advance_reminder_fire_at_ms(_setting(None), 1_000_000_000_000) is None


def test_advance_reminder_due_uses_scheduled_start_not_discovery_time():
    setting = _setting("30min")
    scheduled_start_ms = 1_000_000_000_000
    fire_at = scheduled_start_ms - 30 * 60_000
    assert is_advance_reminder_due(setting, scheduled_start_ms, now_ms=fire_at, window_ms=15 * 60_000) is True
    assert is_advance_reminder_due(setting, scheduled_start_ms, now_ms=fire_at - 1, window_ms=15 * 60_000) is False
    assert is_advance_reminder_due(setting, scheduled_start_ms, now_ms=fire_at + 15 * 60_000, window_ms=15 * 60_000) is False


def test_advance_reminder_not_due_when_setting_has_no_advance_reminder():
    assert is_advance_reminder_due(_setting(None), 1_000_000, now_ms=1_000_000, window_ms=900_000) is False


def test_start_reminder_due_window():
    setting = _setting("1hour")
    scheduled_start_ms = 2_000_000_000_000
    assert is_start_reminder_due(setting, scheduled_start_ms, now_ms=scheduled_start_ms, window_ms=900_000) is True
    assert is_start_reminder_due(setting, scheduled_start_ms, now_ms=scheduled_start_ms - 1, window_ms=900_000) is False


def test_start_and_advance_can_both_be_due_at_their_own_respective_windows_independently():
    """Notify-at-start and the advance reminder are independent, both-can-apply dimensions."""
    setting = _setting("30min")
    scheduled_start_ms = 1_000_000_000_000
    advance_fire_at = scheduled_start_ms - 30 * 60_000
    assert is_advance_reminder_due(setting, scheduled_start_ms, now_ms=advance_fire_at, window_ms=900_000) is True
    assert is_start_reminder_due(setting, scheduled_start_ms, now_ms=advance_fire_at, window_ms=900_000) is False
    assert is_advance_reminder_due(setting, scheduled_start_ms, now_ms=scheduled_start_ms, window_ms=900_000) is False
    assert is_start_reminder_due(setting, scheduled_start_ms, now_ms=scheduled_start_ms, window_ms=900_000) is True
