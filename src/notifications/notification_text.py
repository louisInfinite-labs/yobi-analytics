"""The wording of every push notification the dispatcher sends, in one place.

Three locales are supported (zh-TW, ja, en); an unknown, missing or non-string locale means en. A notification is a (title, body) pair:

- the TITLE is a localized template around the creator's display name (new video / 1 hour / 30 minutes / 10 minutes / 1 minute / scheduled start);
  the start title only says the SCHEDULED start has arrived -- it is sent when the stored start time comes, before (and without) any confirmation
  that the broadcast is actually live, so it never claims the stream "is live" or "has started";
- a late-discovery CATCH-UP advance reminder (the stream only became known after its reminder time) names the ACTUAL minutes left ("about N
  minutes") instead of the configured offset, which would no longer be true;
- the BODY is the original YouTube video or stream title, passed through untouched -- it is never translated, trimmed or rewritten -- or a
  short localized fallback when that title is missing or blank.

Title and body are ALWAYS non-empty (push_sender.build_payload rejects an empty one and the push would never leave), and the service worker shows
both exactly as received. Nothing here decides WHEN or TO WHOM a notification is sent; it only words one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

DEFAULT_LOCALE = "en"
SUPPORTED_LOCALES = ("zh-TW", "ja", "en")

KIND_START = "start"
KIND_ADVANCE = "advance"
ADVANCE_KEYS = ("1hour", "30min", "10min", "1min")


@dataclass(frozen=True)
class NotificationText:
    """One notification's final title and body."""

    title: str
    body: str


@dataclass(frozen=True)
class _LocaleStrings:
    new_video_title: str
    advance_titles: dict[str, str]
    late_advance_title: str  # {minutes} is the actual whole minutes left
    start_title: str
    fallback_video_body: str
    fallback_stream_body: str
    fallback_creator_name: str


_STRINGS: dict[str, _LocaleStrings] = {
    "zh-TW": _LocaleStrings(
        new_video_title="{name} 發布了新影片",
        advance_titles={
            "1hour": "{name} 將於 1 小時後開播",
            "30min": "{name} 將於 30 分鐘後開播",
            "10min": "{name} 將於 10 分鐘後開播",
            "1min": "{name} 將於 1 分鐘後開播",
        },
        late_advance_title="{name} 將於約 {minutes} 分鐘後開播",
        start_title="{name} 預定現在開播",
        fallback_video_body="新影片",
        fallback_stream_body="直播",
        fallback_creator_name="你追蹤的創作者",
    ),
    "ja": _LocaleStrings(
        new_video_title="{name} が新しい動画を公開しました",
        advance_titles={
            "1hour": "{name} は1時間後に配信開始",
            "30min": "{name} は30分後に配信開始",
            "10min": "{name} は10分後に配信開始",
            "1min": "{name} は1分後に配信開始",
        },
        late_advance_title="{name} は約{minutes}分後に配信開始",
        start_title="{name} の配信開始予定時刻です",
        fallback_video_body="新しい動画",
        fallback_stream_body="配信",
        fallback_creator_name="フォロー中の配信者",
    ),
    "en": _LocaleStrings(
        new_video_title="{name} posted a new video",
        advance_titles={
            "1hour": "{name} goes live in 1 hour",
            "30min": "{name} goes live in 30 minutes",
            "10min": "{name} goes live in 10 minutes",
            "1min": "{name} goes live in 1 minute",
        },
        late_advance_title="{name} goes live in about {minutes} minutes",
        start_title="{name} is scheduled to go live now",
        fallback_video_body="New video",
        fallback_stream_body="Live stream",
        fallback_creator_name="A creator you follow",
    ),
}


def normalize_locale(raw: Any) -> str:
    """A supported canonical locale, else en: a missing value, a non-string or an unsupported locale all fall back to the default."""
    return raw if isinstance(raw, str) and raw in _STRINGS else DEFAULT_LOCALE


def _present(value: Any) -> bool:
    """Whether value is a string with something visible in it (None, non-strings and blank strings are not)."""
    return isinstance(value, str) and bool(value.strip())


def _name(strings: _LocaleStrings, creator_name: Any) -> str:
    return creator_name if _present(creator_name) else strings.fallback_creator_name


def new_video_notification(*, locale: Any, creator_name: Any, video_title: Any) -> NotificationText:
    """The notification for a newly discovered video. `video_title` is shown exactly as given."""
    strings = _STRINGS[normalize_locale(locale)]
    title = strings.new_video_title.replace("{name}", _name(strings, creator_name))
    body = video_title if _present(video_title) else strings.fallback_video_body
    return NotificationText(title=title, body=body)


def reminder_notification(
    *, locale: Any, kind: str, advance: str | None, creator_name: Any, stream_title: Any, remaining_minutes: int | None = None
) -> NotificationText:
    """The notification for a live reminder: kind "start" (the stream's SCHEDULED start has arrived -- not a claim that it is live), or kind
    "advance" with one of ADVANCE_KEYS.

    `remaining_minutes` (advance only) marks a late-discovery CATCH-UP: the title then says "about N minutes" with the actual time left rather
    than the configured offset. It must be a whole number of at least 2; anything else is refused.

    `stream_title` is shown exactly as given. Raises ValueError for a kind / advance value this module does not know -- a programming error,
    never user data (the dispatcher only passes values it validated).
    """
    strings = _STRINGS[normalize_locale(locale)]
    if kind == KIND_START and remaining_minutes is None:
        template = strings.start_title
    elif kind == KIND_ADVANCE and advance in strings.advance_titles and remaining_minutes is None:
        template = strings.advance_titles[advance]
    elif kind == KIND_ADVANCE and advance in strings.advance_titles and isinstance(remaining_minutes, int) and not isinstance(remaining_minutes, bool) and remaining_minutes >= 2:
        template = strings.late_advance_title.replace("{minutes}", str(remaining_minutes))
    else:
        raise ValueError(f"unknown reminder notification: kind={kind!r}, advance={advance!r}, remaining_minutes={remaining_minutes!r}")
    body = stream_title if _present(stream_title) else strings.fallback_stream_body
    return NotificationText(title=template.replace("{name}", _name(strings, creator_name)), body=body)
