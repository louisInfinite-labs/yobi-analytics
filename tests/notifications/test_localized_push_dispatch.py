"""End to end through the dispatcher and the REAL payload builder: what a client of each locale actually receives, and that nothing else changed."""

from __future__ import annotations

import json
from datetime import timedelta

import pytest

from api import read_api
from notifications import live_reminder, new_video_dispatcher, notification_dispatch, notification_dispatcher, push_sender
from stores import remote_config_store

from .new_video_harness import DAY1_EVENING, due_event, fake_delivery_log, install_world
from .test_notification_dispatcher import (  # noqa: F401  (autouse fixtures must be visible in this module)
    _frozen_datetime,
    _holodex_stream,
    _preference_value,
    _remote_config_stub,
    stub_creators,
    stub_live_streams,
    stub_reminder_items,
    stub_vapid,
)
from .test_reminder_timing_matrix import ALL_TIMINGS, START, STREAM, fire_at, reminders_for, run

JA_STREAM_TITLE = "【APEX】ランクマ！ 深夜ソロ配信 #ぶいすぽ"
NAME = "藍沢エマ"  # the stubbed creator's display name
EXPECTED_TITLE = {
    "zh-TW": {"1hour": "藍沢エマ 將於 1 小時後開播", "30min": "藍沢エマ 將於 30 分鐘後開播", "10min": "藍沢エマ 將於 10 分鐘後開播", "1min": "藍沢エマ 將於 1 分鐘後開播", "start": "藍沢エマ 預定現在開播", "new_video": "藍沢エマ 發布了新影片"},
    "ja": {"1hour": "藍沢エマ は1時間後に配信開始", "30min": "藍沢エマ は30分後に配信開始", "10min": "藍沢エマ は10分後に配信開始", "1min": "藍沢エマ は1分後に配信開始", "start": "藍沢エマ の配信開始予定時刻です", "new_video": "藍沢エマ が新しい動画を公開しました"},
    "en": {"1hour": "藍沢エマ goes live in 1 hour", "30min": "藍沢エマ goes live in 30 minutes", "10min": "藍沢エマ goes live in 10 minutes", "1min": "藍沢エマ goes live in 1 minute", "start": "藍沢エマ is scheduled to go live now", "new_video": "藍沢エマ posted a new video"},
}


def reminder_payloads(monkeypatch, *, timing, preference, stream=STREAM):
    """The pushes one dispatcher run sends at the moment `timing` fires, for a client whose reminder source is its creator 全部 setting."""
    return run(monkeypatch, now=fire_at(timing), streams=[stream], preference=preference, **reminders_for("creator_all", timing))


def new_video_payloads(monkeypatch, *, preference, title="新曲MVを公開しました【オリジナル】"):
    """The pushes one 30-minute slot run sends (18:00 JST tick, after yesterday's 18:00 discovery's next delivery window)."""
    fake_delivery_log(monkeypatch)
    install_world(monkeypatch, events=[due_event(title=title)], preferences={"c1": preference}, stub_push=False)
    sent = []
    monkeypatch.setattr(push_sender, "webpush", lambda *, subscription_info, data, **kwargs: sent.append(json.loads(data)))
    assert new_video_dispatcher.run({}, None, now=DAY1_EVENING)["delivered"] == 1
    return sent


@pytest.mark.parametrize("timing", ALL_TIMINGS)
@pytest.mark.parametrize("locale", ["zh-TW", "ja", "en"])
def test_every_reminder_type_reaches_a_client_in_its_own_language_with_the_original_stream_title(monkeypatch, locale, timing):
    stream = _holodex_stream(videoId="sf6_stream", title=JA_STREAM_TITLE)

    [payload] = reminder_payloads(monkeypatch, timing=timing, preference=_preference_value(notificationLocale=locale), stream=stream)

    assert payload["title"] == EXPECTED_TITLE[locale][timing]
    assert payload["body"] == JA_STREAM_TITLE  # the original Japanese title, never translated
    assert payload["data"] == {"videoId": "sf6_stream", "reminderKind": "start" if timing == "start" else "advance"}


@pytest.mark.parametrize("locale", ["zh-TW", "ja", "en"])
def test_a_new_video_reaches_a_client_in_its_own_language_with_the_original_video_title(monkeypatch, locale):
    original = "新曲MVを公開しました【オリジナル】"

    [payload] = new_video_payloads(monkeypatch, preference=_preference_value(notificationLocale=locale), title=original)

    assert payload["title"] == EXPECTED_TITLE[locale]["new_video"]
    assert payload["body"] == original
    assert payload["data"] == {"videoId": "v1"}


@pytest.mark.parametrize("preference", [_preference_value(), _preference_value(notificationLocale=None), _preference_value(notificationLocale="fr"), _preference_value(notificationLocale=5)])
def test_a_client_with_no_or_an_unsupported_locale_gets_english(monkeypatch, preference):
    [reminder] = reminder_payloads(monkeypatch, timing="10min", preference=preference)
    [video] = new_video_payloads(monkeypatch, preference=preference)

    assert reminder["title"] == "藍沢エマ goes live in 10 minutes"
    assert video["title"] == "藍沢エマ posted a new video"


@pytest.mark.parametrize("locale", ["zh-TW", "ja", "en"])
def test_a_stream_with_no_title_still_gets_a_non_empty_localized_body(monkeypatch, locale):
    stream = _holodex_stream(videoId="sf6_stream", title="")

    [payload] = reminder_payloads(monkeypatch, timing="start", preference=_preference_value(notificationLocale=locale), stream=stream)

    assert payload["body"] == {"zh-TW": "直播", "ja": "配信", "en": "Live stream"}[locale]
    assert payload["title"].strip()


@pytest.mark.parametrize("locale", ["zh-TW", "ja", "en"])
def test_a_video_with_no_title_still_gets_a_non_empty_localized_body(monkeypatch, locale):
    [payload] = new_video_payloads(monkeypatch, preference=_preference_value(notificationLocale=locale), title="")

    assert payload["body"] == {"zh-TW": "新影片", "ja": "新しい動画", "en": "New video"}[locale]


def test_an_unknown_creator_uses_the_localized_fallback_name(monkeypatch):
    monkeypatch.setattr(notification_dispatcher, "load_creators", lambda: [])  # the creator is not in the registry

    [payload] = reminder_payloads(monkeypatch, timing="start", preference=_preference_value(notificationLocale="zh-TW"))

    assert payload["title"] == "你追蹤的創作者 預定現在開播"


def test_the_stream_title_is_stored_in_the_schedule_snapshot_and_read_back_for_the_notification(monkeypatch):
    now = START - timedelta(minutes=30)
    stream = _holodex_stream(videoId="sf6_stream", title=JA_STREAM_TITLE)
    written = {}
    monkeypatch.setattr(read_api, "get_live_streams", lambda *_a, **_kw: {"streams": [stream]})
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(now))
    monkeypatch.setattr(remote_config_store, "get_remote_config", _remote_config_stub(subscription=None))
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: written.update(record))

    entries = notification_dispatcher._refresh_and_load_stream_schedule(now=now)

    assert written["value"]["entries"]["sf6_stream"]["title"] == JA_STREAM_TITLE
    assert entries["sf6_stream"].title == JA_STREAM_TITLE


def test_a_snapshot_stored_before_titles_existed_still_loads_and_the_notification_falls_back(monkeypatch):
    snapshot = live_reminder.parse_stream_schedule_snapshot(
        {"entries": {"old": {"creatorId": "aizawa_ema", "scheduledStartMs": 1000, "topic": None}}, "refreshedAt": "2026-09-03T09:00:00+00:00"}
    )

    assert snapshot.entries["old"].title is None


@pytest.mark.parametrize("bad_title", [123, ["x"], {"a": 1}, "   ", None])
def test_a_malformed_stored_title_never_invalidates_the_snapshot(bad_title):
    snapshot = live_reminder.parse_stream_schedule_snapshot(
        {"entries": {"v": {"creatorId": "aizawa_ema", "scheduledStartMs": 1000, "title": bad_title}}, "refreshedAt": "2026-09-03T09:00:00+00:00"}
    )

    assert snapshot.entries["v"].title is None


class TestNotificationLocaleInThePreference:
    def parse(self, **overrides):
        return notification_dispatch.parse_notification_preference(_preference_value(**overrides))

    @pytest.mark.parametrize("locale", ["zh-TW", "ja", "en"])
    def test_each_supported_locale_is_kept(self, locale):
        assert self.parse(notificationLocale=locale).locale == locale

    @pytest.mark.parametrize("raw", [None, "", "fr", "zh-CN", 3, ["ja"], True])
    def test_a_missing_or_unsupported_value_is_english_not_an_error(self, raw):
        assert self.parse(notificationLocale=raw).locale == "en"

    def test_a_preference_stored_before_the_field_existed_is_english(self):
        raw = _preference_value()
        raw.pop("notificationLocale", None)

        assert notification_dispatch.parse_notification_preference(raw).locale == "en"


def test_the_locale_does_not_change_when_a_reminder_fires_or_who_gets_it(monkeypatch):
    """Wording only: the same moments fire and the same dedupe applies whatever the locale (timing/no-replay semantics are untouched)."""
    for locale in ("zh-TW", "ja", "en"):
        preference = _preference_value(notificationLocale=locale)
        due = fire_at("30min")
        assert run(monkeypatch, now=due - timedelta(seconds=1), streams=[STREAM], preference=preference, **reminders_for("creator_all", "30min")) == []
        assert len(run(monkeypatch, now=due, streams=[STREAM], preference=preference, **reminders_for("creator_all", "30min"))) == 1
        assert run(monkeypatch, now=due + timedelta(seconds=60), streams=[STREAM], preference=preference, **reminders_for("creator_all", "30min")) == []
