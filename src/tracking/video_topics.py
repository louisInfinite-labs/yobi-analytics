"""Canonical video topic taxonomy and the deterministic title classifier."""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Iterable, Mapping, NamedTuple

OTHER_TOPIC = "other"

_KATAKANA = "ァ-ヶー"


class Topic(NamedTuple):
    id: str
    # Display label per frontend locale ("zh-TW"/"en"/"ja") -- GET /topics
    # (dashboard_catalog_api.get_topics) hands this straight to the frontend,
    # which is the single place these labels are rendered. The frontend owns
    # no label of its own for a backend topic any more: adding a topic here
    # is the only change needed for it to render correctly in every locale.
    labels: Mapping[str, str]
    # Regex run against the NFKC-normalized, casefolded title; None for the fallback topic.
    pattern: str | None
    # Explicit, hand-audited literal forms from this topic's own `pattern` above -- every branch of
    # the regex that is a finite literal alternative (optionally with an optional interior space, or a
    # bounded `(a|b)` choice), with the pattern's word-boundary lookaround assertions stripped (they
    # guard against false positives when scanning free-form title text; they add nothing to a literal
    # list meant to be compared via prefix-matching). Exposed through GET /topics (dashboard_catalog_api.
    # get_topics) as `searchAliases` -- the Video List Multilingual Search feature's final architecture
    # (Search-session cache follow-up) resolves a Search query to canonical topic ids ON THE FRONTEND,
    # against this SAME downloaded authoritative catalog (id + labels + searchAliases), via a monotonic
    # prefix-matching rule (frontend/dashboard/src/features/video-search/model/topicResolution.ts) --
    # never against `pattern`'s regex-reuse (tracking.video_topics.topics_matching_text), which is NOT
    # monotonic under query extension (see that function's own docstring) and is therefore unsafe as a
    # basis for the frontend's local Search-session narrowing. Each alias here is independently verified
    # (tests/tracking/test_video_topics.py) to actually be matched by this topic's own `pattern`, so a
    # transcription error is caught by comparing against the one real backend source of truth rather than
    # trusted by inspection alone. Empty for the fallback topic (no pattern to source synonyms from) and
    # for any topic whose pattern is already fully covered by its own id/labels.
    search_aliases: tuple[str, ...] = ()


# Tuple order is both the display order and the match precedence: game topics
# first, then singing, then mv (published music works), then chatting. A
# title matching several topics gets the earliest one. Persisted values are
# the ids, never the labels.
TOPICS: tuple[Topic, ...] = (
    Topic(
        "valorant",
        {"zh-TW": "VALO", "en": "VALO", "ja": "VALO"},
        rf"valorant|(?<![a-z0-9])valo(?![a-z0-9])|バロラント|ヴァロ(?:ラント)?(?![{_KATAKANA}])",
        search_aliases=("valorant", "valo", "バロラント", "ヴァロ", "ヴァロラント"),
    ),
    Topic(
        "sf6",
        {"zh-TW": "SF6", "en": "SF6", "ja": "SF6"},
        rf"(?<![a-z0-9])sf6(?![0-9])|street ?fighter ?(?:6|vi)(?![0-9a-z])"
        rf"|ストリートファイター ?(?:6|vi)|(?<![{_KATAKANA}])スト ?6(?![0-9])",
        search_aliases=(
            "sf6",
            "streetfighter6", "streetfightervi", "streetfighter 6", "streetfighter vi",
            "street fighter6", "street fightervi", "street fighter 6", "street fighter vi",
            "ストリートファイター6", "ストリートファイターvi", "ストリートファイター 6", "ストリートファイター vi",
            "スト6", "スト 6",
        ),
    ),
    Topic(
        "apex",
        {"zh-TW": "Apex", "en": "Apex", "ja": "Apex"},
        rf"(?<![a-z0-9])apex(?![a-z0-9])|apex ?legends|(?<![{_KATAKANA}])エーペックス|(?<![{_KATAKANA}])エペ(?![{_KATAKANA}])",
        search_aliases=("apex", "apexlegends", "apex legends", "エーペックス", "エペ"),
    ),
    Topic(
        "minecraft",
        {"zh-TW": "Minecraft", "en": "Minecraft", "ja": "Minecraft"},
        r"minecraft|マインクラフト|マイクラ",
        search_aliases=("minecraft", "マインクラフト", "マイクラ"),
    ),
    # Livestream/archive singing only. 歌ってみた (an uploaded cover) is a published music work, so it is mv,
    # not singing -- see the mv topic below and test_uploaded_cover_is_mv.
    Topic(
        "singing",
        {"zh-TW": "歌回", "en": "Singing", "ja": "歌枠"},
        r"歌枠|歌回|歌配信|karaoke|カラオケ|(?<![a-z])singing(?![a-z])",
        search_aliases=("歌枠", "歌回", "歌配信", "karaoke", "カラオケ", "singing"),
    ),
    # Published music works -- uploaded covers (歌ってみた, cover) and original songs alike share this one
    # id (no separate cover/original_song/music_video values). Deliberately
    # narrow, explicit markers only: no bare "歌"/"original"/"song"/"music",
    # which would false-positive on unrelated titles (e.g. "空月の歌" must stay
    # "other", not become mv just for containing 歌).
    Topic(
        "mv",
        {"zh-TW": "MV", "en": "MV", "ja": "MV"},
        r"(?<![a-z0-9])mv(?![a-z0-9])|(?<![a-z0-9])music ?video(?![a-z0-9])"
        r"|(?<![a-z0-9])cover(?:ed)?(?![a-z0-9])"
        r"|(?<![a-z0-9])original ?song(?![a-z0-9])"
        r"|歌ってみた|オリジナル曲|原創曲|原創歌曲",
        search_aliases=(
            "mv", "musicvideo", "music video", "cover", "covered", "originalsong", "original song",
            "歌ってみた", "オリジナル曲", "原創曲", "原創歌曲",
        ),
    ),
    Topic(
        "chatting",
        {"zh-TW": "雜談", "en": "Chatting", "ja": "雑談"},
        r"雑談|zatsudan|free ?talk|(?<![a-z])chatting(?![a-z])",
        search_aliases=("雑談", "zatsudan", "freetalk", "free talk", "chatting"),
    ),
    Topic(OTHER_TOPIC, {"zh-TW": "其他", "en": "Other", "ja": "その他"}, None),
)

TOPIC_IDS = frozenset(topic.id for topic in TOPICS)

_COMPILED_PATTERNS = tuple((topic.id, re.compile(topic.pattern)) for topic in TOPICS if topic.pattern)


def classify_video_topic(title: str) -> str:
    """Return the single primary topic id for a video title, `other` when nothing matches."""
    normalized = unicodedata.normalize("NFKC", title).casefold()
    return next((topic_id for topic_id, pattern in _COMPILED_PATTERNS if pattern.search(normalized)), OTHER_TOPIC)


def topics_matching_text(text: str) -> frozenset[str]:
    """Every topic id whose classification pattern matches `text` (NFKC + casefold normalized first,
    the same convention classify_video_topic uses) -- the UNION of every match, not just the single
    primary topic classify_video_topic would pick for a real video title.

    Used by Video Search (src/search/video_search.py) to resolve a user's search query to every
    canonical topic it legitimately refers to, reusing the exact same authoritative multilingual
    keyword patterns topic classification already depends on (e.g. "VALO"/"バロラント"/"ヴァロ" all
    already resolve to valorant here) -- there is no separate alias database to invent or keep in sync.
    """
    normalized = unicodedata.normalize("NFKC", text).casefold()
    return frozenset(topic_id for topic_id, pattern in _COMPILED_PATTERNS if pattern.search(normalized))


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
