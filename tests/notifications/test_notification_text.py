"""The localized push wording: every template in zh-TW / ja / en, the fallbacks, and the "never empty, never rewritten" guarantees."""

from __future__ import annotations

import pytest

from notifications import notification_text as nt
from notifications.notification_text import (
    ADVANCE_KEYS,
    DEFAULT_LOCALE,
    KIND_ADVANCE,
    KIND_START,
    SUPPORTED_LOCALES,
    new_video_notification,
    normalize_locale,
    reminder_notification,
)

NAME = "藍沢エマ"
JA_TITLE = "【APEX】ランクマ！ #ぶいすぽ 深夜配信"

# The exact approved wording. (locale, notification) -> title template; {name} is the creator's display name.
TITLES = {
    "zh-TW": {
        "new_video": "{name} 發布了新影片",
        "1hour": "{name} 將於 1 小時後開播",
        "30min": "{name} 將於 30 分鐘後開播",
        "10min": "{name} 將於 10 分鐘後開播",
        "1min": "{name} 將於 1 分鐘後開播",
        "start": "{name} 預定現在開播",
    },
    "ja": {
        "new_video": "{name} が新しい動画を公開しました",
        "1hour": "{name} は1時間後に配信開始",
        "30min": "{name} は30分後に配信開始",
        "10min": "{name} は10分後に配信開始",
        "1min": "{name} は1分後に配信開始",
        "start": "{name} の配信開始予定時刻です",
    },
    "en": {
        "new_video": "{name} posted a new video",
        "1hour": "{name} goes live in 1 hour",
        "30min": "{name} goes live in 30 minutes",
        "10min": "{name} goes live in 10 minutes",
        "1min": "{name} goes live in 1 minute",
        "start": "{name} is scheduled to go live now",
    },
}
FALLBACKS = {
    "zh-TW": {"video_body": "新影片", "stream_body": "直播", "creator": "你追蹤的創作者"},
    "ja": {"video_body": "新しい動画", "stream_body": "配信", "creator": "フォロー中の配信者"},
    "en": {"video_body": "New video", "stream_body": "Live stream", "creator": "A creator you follow"},
}
ALL_NOTIFICATIONS = ["new_video", *ADVANCE_KEYS, "start"]


def build(locale, notification, *, name=NAME, original=JA_TITLE):
    if notification == "new_video":
        return new_video_notification(locale=locale, creator_name=name, video_title=original)
    if notification == "start":
        return reminder_notification(locale=locale, kind=KIND_START, advance=None, creator_name=name, stream_title=original)
    return reminder_notification(locale=locale, kind=KIND_ADVANCE, advance=notification, creator_name=name, stream_title=original)


def test_the_three_supported_locales_and_the_default():
    assert SUPPORTED_LOCALES == ("zh-TW", "ja", "en")
    assert DEFAULT_LOCALE == "en"
    assert set(TITLES) == set(SUPPORTED_LOCALES)


@pytest.mark.parametrize("notification", ALL_NOTIFICATIONS)
@pytest.mark.parametrize("locale", SUPPORTED_LOCALES)
def test_every_notification_type_in_every_locale_uses_the_exact_title_template_and_the_original_title_as_body(locale, notification):
    text = build(locale, notification)

    assert text.title == TITLES[locale][notification].replace("{name}", NAME)
    assert text.body == JA_TITLE


@pytest.mark.parametrize("notification", ALL_NOTIFICATIONS)
@pytest.mark.parametrize("locale", ["zh-TW", "en"])
def test_the_original_japanese_title_is_never_translated_or_altered_under_zh_tw_and_en(locale, notification):
    original = "  【歌枠】雨の日に聴きたい曲  (#うたわく)  "

    assert build(locale, notification, original=original).body == original  # same string, whitespace and all


@pytest.mark.parametrize("raw", [None, "", "fr", "zh-CN", "ZH-TW", "zh_TW", 7, ["ja"], {"locale": "ja"}, True])
def test_a_missing_or_unsupported_locale_falls_back_to_english(raw):
    assert normalize_locale(raw) == "en"
    assert build(raw, "start").title == "藍沢エマ is scheduled to go live now"
    assert build(raw, "new_video").title == "藍沢エマ posted a new video"


@pytest.mark.parametrize("locale", SUPPORTED_LOCALES)
def test_a_supported_locale_is_kept_as_is(locale):
    assert normalize_locale(locale) == locale


@pytest.mark.parametrize("notification", ALL_NOTIFICATIONS)
@pytest.mark.parametrize("locale", SUPPORTED_LOCALES)
@pytest.mark.parametrize("name", [None, "", "   ", "\n"])
def test_a_missing_creator_name_uses_the_localized_fallback_name(locale, notification, name):
    text = build(locale, notification, name=name)

    assert text.title == TITLES[locale][notification].replace("{name}", FALLBACKS[locale]["creator"])


@pytest.mark.parametrize("locale", SUPPORTED_LOCALES)
@pytest.mark.parametrize("title", [None, "", "  ", "\t\n", 123, ["x"]])
def test_a_missing_video_title_uses_the_localized_fallback_body(locale, title):
    assert build(locale, "new_video", original=title).body == FALLBACKS[locale]["video_body"]


@pytest.mark.parametrize("notification", [*ADVANCE_KEYS, "start"])
@pytest.mark.parametrize("locale", SUPPORTED_LOCALES)
@pytest.mark.parametrize("title", [None, "", "  ", "\t\n", 123])
def test_a_missing_stream_title_uses_the_localized_fallback_body(locale, notification, title):
    assert build(locale, notification, original=title).body == FALLBACKS[locale]["stream_body"]


@pytest.mark.parametrize("notification", ALL_NOTIFICATIONS)
@pytest.mark.parametrize("locale", [*SUPPORTED_LOCALES, None, "xx"])
@pytest.mark.parametrize("name", [NAME, None, ""])
@pytest.mark.parametrize("original", [JA_TITLE, None, ""])
def test_title_and_body_are_never_empty_for_any_combination(locale, notification, name, original):
    text = build(locale, notification, name=name, original=original)

    assert text.title.strip() and text.body.strip()


def test_a_creator_name_containing_braces_is_inserted_literally():
    assert new_video_notification(locale="en", creator_name="{name} {x}", video_title="v").title == "{name} {x} posted a new video"


def test_an_unknown_reminder_kind_or_advance_value_is_a_programming_error():
    with pytest.raises(ValueError):
        reminder_notification(locale="en", kind="later", advance=None, creator_name="a", stream_title="s")
    with pytest.raises(ValueError):
        reminder_notification(locale="en", kind=KIND_ADVANCE, advance="2hour", creator_name="a", stream_title="s")
    with pytest.raises(ValueError):
        reminder_notification(locale="en", kind=KIND_ADVANCE, advance=None, creator_name="a", stream_title="s")


def test_every_locale_defines_every_advance_key_and_nothing_else_is_missing():
    for locale in SUPPORTED_LOCALES:
        strings = nt._STRINGS[locale]
        assert set(strings.advance_titles) == set(ADVANCE_KEYS)
        assert "{name}" in strings.new_video_title and "{name}" in strings.start_title
        assert all("{name}" in title for title in strings.advance_titles.values())
