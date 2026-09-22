"""Canonical video topic taxonomy and the deterministic title classifier."""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Iterable, Mapping, NamedTuple

OTHER_TOPIC = "other"

_KATAKANA = "ァ-ヶー"


class Topic(NamedTuple):
    id: str
    label: str
    # Regex run against the NFKC-normalized, casefolded title; None for the fallback topic.
    pattern: str | None


# Tuple order is both the display order and the match precedence: game topics
# first, then singing, then chatting. A title matching several topics gets the
# earliest one. Persisted values are the ids, never the labels.
TOPICS: tuple[Topic, ...] = (
    Topic(
        "valorant",
        "VALORANT",
        rf"valorant|(?<![a-z0-9])valo(?![a-z0-9])|バロラント|ヴァロ(?:ラント)?(?![{_KATAKANA}])",
    ),
    Topic(
        "sf6",
        "SF6",
        rf"(?<![a-z0-9])sf6(?![0-9])|street ?fighter ?(?:6|vi)(?![0-9a-z])"
        rf"|ストリートファイター ?(?:6|vi)|(?<![{_KATAKANA}])スト ?6(?![0-9])",
    ),
    Topic(
        "apex",
        "APEX",
        rf"(?<![a-z0-9])apex(?![a-z0-9])|apex ?legends|(?<![{_KATAKANA}])エーペックス|(?<![{_KATAKANA}])エペ(?![{_KATAKANA}])",
    ),
    Topic("minecraft", "Minecraft", r"minecraft|マインクラフト|マイクラ"),
    # 歌ってみた (an uploaded cover) is deliberately singing, not other.
    Topic("singing", "Singing", r"歌枠|歌回|歌配信|歌ってみた|karaoke|カラオケ|(?<![a-z])singing(?![a-z])"),
    Topic("chatting", "Chatting", r"雑談|zatsudan|free ?talk|(?<![a-z])chatting(?![a-z])"),
    Topic(OTHER_TOPIC, "Other", None),
)

TOPIC_IDS = frozenset(topic.id for topic in TOPICS)

_COMPILED_PATTERNS = tuple((topic.id, re.compile(topic.pattern)) for topic in TOPICS if topic.pattern)


def classify_video_topic(title: str) -> str:
    """Return the single primary topic id for a video title, `other` when nothing matches."""
    normalized = unicodedata.normalize("NFKC", title).casefold()
    return next((topic_id for topic_id, pattern in _COMPILED_PATTERNS if pattern.search(normalized)), OTHER_TOPIC)


def resolve_video_topics(items: Iterable[Mapping[str, Any]]) -> dict[str, str]:
    """videoId -> topic, classifying from title in memory when a persisted
    `topic` is missing OR is not one of the canonical TOPIC_IDS (Topic Phase
    3: the live topic backfill has not necessarily run, so ranking must not
    depend on it; a corrupted/stale/manually-edited persisted value must
    never leak an unrecognized string into a downstream cache key). A
    missing or empty `title` classifies safely to OTHER_TOPIC (the same
    "nothing matched" result classify_video_topic already returns for a
    genuinely unclassifiable title), never a KeyError. Read-only — never
    writes the classified result back anywhere; a caller that also wants to
    persist it must do that itself via a separate, explicit write.
    """
    resolved: dict[str, str] = {}
    for item in items:
        persisted = item.get("topic")
        if persisted in TOPIC_IDS:
            resolved[item["videoId"]] = persisted
        else:
            resolved[item["videoId"]] = classify_video_topic(item.get("title") or "")
    return resolved
