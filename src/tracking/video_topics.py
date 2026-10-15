"""Canonical video topic taxonomy and the deterministic title classifier.

The taxonomy is NOT defined in code. The DynamoDB table YobiTopicCatalog, partition catalog_id="GLOBAL", is the single source
of truth for which topic ids exist, their order (display_order = display order AND first-match-wins precedence), their zh-TW/en/ja
labels and their search aliases (stores.topic_catalog_store). This module only (a) turns that catalog into the live `Taxonomy`
(cached, refreshed every CATALOG_TTL_SECONDS, fail-safe: the last good copy, else FALLBACK_TOPIC_IDS), and (b) supplies the curated
title patterns the classifier applies to the topics the catalog contains.

Patterns are a code-side library (`PATTERN_LIBRARY`, keyed by topic id). A catalog topic is classified from titles only when the
library holds a pattern for its id (or for the one id CATALOG_PATTERN_SOURCE explicitly maps it to). A catalog topic with no pattern is
still a fully valid id everywhere (GET /topics, topic filters, search aliases, reminder scopes) -- it simply is not assigned
automatically. Search aliases are never turned into classification patterns: they are matching phrases for the search box, and
classifying every title containing e.g. "生放送" or "3d" would silently re-file a large share of the catalog. The REVIEW partition is
never read.
"""

from __future__ import annotations

import re
import threading
import time
import unicodedata
from collections.abc import Callable, Iterator, Sequence
from collections.abc import Set as AbstractSet
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
    # GET /topics' legacy single-string `label` (catalog attribute `legacy_label`); None -> the response falls back to the English label.
    legacy_label: str | None = None


# Tuple order is both the display order and the match precedence: game topics
# first, then singing, then mv (published music works), then chatting. A
# title matching several topics gets the earliest one. Persisted values are
# the ids, never the labels.
PATTERN_LIBRARY: tuple[Topic, ...] = (
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
    # --- Topic Discovery batch 1: 49 highest-confidence candidates found by analyzing
    # 97,604 production videos persisted topic="other" (full methodology + dry-run
    # coverage: scripts/analysis/proposed_topic_classification.py / compute_dry_run_coverage.py).
    # Inserted strictly AFTER the original 7 non-fallback topics and BEFORE the "other"
    # fallback, so first-match-wins + tuple order guarantees no existing valorant/sf6/apex/
    # minecraft/singing/mv/chatting classification can ever change by adding these.
    Topic("dance_cover", {"zh-TW": "翻跳", "en": "Dance Cover", "ja": "踊ってみた"}, r"踊ってみた"),
    Topic("pokemon", {"zh-TW": "寶可夢", "en": "Pokémon", "ja": "ポケモン"}, r"pok[eé]mon|ポケモン|ポケカ|シャイニングパール|ブリリアントダイヤモンド"),
    Topic("ark_survival", {"zh-TW": "方舟：生存進化", "en": "ARK: Survival Evolved", "ja": "ARK"}, r"(?<![a-z0-9])ark(?![a-z0-9])|ark: ?survival"),
    Topic("watchalong", {"zh-TW": "同步觀看", "en": "Watchalong", "ja": "同時視聴"}, r"同時視聴|watch ?along|watch ?party|ウォッチパーティー"),
    Topic("monster_hunter", {"zh-TW": "魔物獵人", "en": "Monster Hunter", "ja": "モンスターハンター"}, r"monster ?hunter|モンスターハンター|モンハン"),
    Topic("league_of_legends", {"zh-TW": "英雄聯盟", "en": "League of Legends", "ja": "League of Legends"}, r"league ?of ?legends|(?<![a-z0-9])lol(?![a-z0-9])"),
    Topic("mario_kart", {"zh-TW": "瑪利歐賽車", "en": "Mario Kart", "ja": "マリオカート"}, r"mario ?kart|マリオカート|マリカ(?![a-z])"),
    Topic("grand_theft_auto", {"zh-TW": "俠盜獵車手", "en": "Grand Theft Auto", "ja": "グランド・セフト・オート"}, r"grand theft auto|(?<![a-z])gta ?\d?(?![a-z])|mad ?town"),
    Topic("rust", {"zh-TW": "Rust", "en": "Rust", "ja": "Rust"}, r"(?<![a-z])rust(?![a-z])"),
    Topic("resident_evil", {"zh-TW": "惡靈古堡", "en": "Resident Evil", "ja": "バイオハザード"}, r"resident ?evil|biohazard|バイオハザード"),
    Topic("super_mario_platformer", {"zh-TW": "瑪利歐(平台/派對系列)", "en": "Super Mario (platformer/party)", "ja": "スーパーマリオ"}, r"super ?mario|マリオメーカー|ペーパーマリオ|マリオパーティ|スーパーマリオ|マリオテニス|マリオオデッセイ|マリオギャラクシー"),
    Topic("splatoon", {"zh-TW": "斯普拉遁", "en": "Splatoon", "ja": "スプラトゥーン"}, r"splatoon|スプラトゥーン|(?<![a-z])スプラ(?![a-z])"),
    Topic("dragon_quest", {"zh-TW": "勇者鬥惡龍", "en": "Dragon Quest", "ja": "ドラゴンクエスト"}, r"dragon ?quest|ドラゴンクエスト|ドラクエ"),
    Topic("elden_ring", {"zh-TW": "艾爾登法環", "en": "Elden Ring", "ja": "エルデンリング"}, r"elden ?ring|エルデンリング"),
    Topic("overwatch", {"zh-TW": "鬥陣特攻", "en": "Overwatch", "ja": "オーバーウォッチ"}, r"overwatch|オーバーウォッチ|ow2(?![a-z0-9])"),
    Topic("asmr", {"zh-TW": "ASMR", "en": "ASMR", "ja": "ASMR"}, r"(?<![a-z])asmr(?![a-z])"),
    Topic("final_fantasy", {"zh-TW": "最終幻想", "en": "Final Fantasy", "ja": "ファイナルファンタジー"}, r"final ?fantasy|ファイナルファンタジー|(?<![a-z0-9])ff\d{0,2}(?![a-z0-9])"),
    Topic("repo_game", {"zh-TW": "R.E.P.O.", "en": "R.E.P.O.", "ja": "R.E.P.O."}, r"(?<![a-z])r\.?e\.?p\.?o\.?(?![a-z])"),
    Topic("among_us", {"zh-TW": "Among Us", "en": "Among Us", "ja": "Among Us"}, r"among ?us|アモアス"),
    Topic("zelda", {"zh-TW": "薩爾達傳說", "en": "The Legend of Zelda", "ja": "ゼルダの伝説"}, r"zelda|ゼルダ"),
    Topic("yakuza", {"zh-TW": "如龍", "en": "Like a Dragon / Yakuza", "ja": "龍が如く"}, r"yakuza|龍が如く|如く極"),
    Topic("seven_days_to_die_survival", {"zh-TW": "七日殺", "en": "7 Days to Die", "ja": "7 Days to Die"}, r"7 ?days to die|7大豆|7dtd"),
    Topic("holocure", {"zh-TW": "HoloCure", "en": "HoloCure", "ja": "HoloCure"}, r"holocure"),
    Topic("pubg", {"zh-TW": "絕地求生", "en": "PUBG: Battlegrounds", "ja": "PUBG"}, r"(?<![a-z])pubg(?![a-z])"),
    Topic("phasmophobia", {"zh-TW": "Phasmophobia", "en": "Phasmophobia", "ja": "Phasmophobia"}, r"phasmophobia"),
    Topic("call_of_duty", {"zh-TW": "決勝時刻", "en": "Call of Duty", "ja": "コール オブ デューティ"}, r"call of duty|(?<![a-z])cod ?[:\s]?(?:wz|bocw|bo6|mw\d?|zombies)|warzone"),
    Topic("tokkomachi", {"zh-TW": "留言等待", "en": "Listener call-in (Tokkomachi)", "ja": "凸待ち"}, r"凸待ち|逆凸"),
    Topic("uma_musume", {"zh-TW": "賽馬娘 Pretty Derby", "en": "Umamusume: Pretty Derby", "ja": "ウマ娘 プリティーダービー"}, r"uma ?musume|ウマ娘|プリティーダービー"),
    Topic("mahjong", {"zh-TW": "麻將(雀魂)", "en": "Mahjong (Jantama)", "ja": "麻雀/雀魂"}, r"雀魂|麻雀|janshi|セガ ?net ?麻雀"),
    Topic("fall_guys", {"zh-TW": "糖豆人", "en": "Fall Guys", "ja": "フォールガイズ"}, r"fall ?guys|フォールガイズ"),
    Topic("asobi_taizen", {"zh-TW": "世界遊戲大全51", "en": "Clubhouse Games: 51 Worldwide Classics", "ja": "世界のアソビ大全51"}, r"アソビ大全|世界のアソビ大全"),
    Topic("persona", {"zh-TW": "女神異聞錄", "en": "Persona", "ja": "ペルソナ"}, r"persona ?\d|ペルソナ"),
    Topic("dead_by_daylight", {"zh-TW": "黎明死線", "en": "Dead by Daylight", "ja": "デッドバイデイライト"}, r"dead by daylight|(?<![a-z])dbd(?![a-z])"),
    Topic("superchat_reading", {"zh-TW": "讀超級留言", "en": "Superchat Reading", "ja": "スパチャ読み"}, r"スパチャ読み|superchat reading|super ?chat.{0,3}reading|donation reading"),
    Topic("tarkov", {"zh-TW": "逃離塔科夫", "en": "Escape from Tarkov", "ja": "タルコフ"}, r"tarkov|タルコフ|escape from tarkov"),
    Topic("palworld", {"zh-TW": "幻獸帕魯", "en": "Palworld", "ja": "パルワールド"}, r"palworld|パルワールド"),
    Topic("lethal_company", {"zh-TW": "Lethal Company", "en": "Lethal Company", "ja": "Lethal Company"}, r"lethal ?company"),
    Topic("shadowverse", {"zh-TW": "闇影詩章", "en": "Shadowverse", "ja": "シャドウバース"}, r"shadowverse|シャドバ"),
    Topic("animal_crossing", {"zh-TW": "集合啦！動物森友會", "en": "Animal Crossing", "ja": "あつまれ どうぶつの森"}, r"animal crossing|あつまれ ?どうぶつの森|どうぶつの森"),
    Topic("tetris_puyo", {"zh-TW": "俄羅斯方塊/魔法氣泡", "en": "Tetris / Puyo Puyo", "ja": "テトリス/ぷよぷよ"}, r"tetris|テトリス|ぷよぷよ|ぷよテト"),
    Topic("power_pro", {"zh-TW": "實況野球(栄冠ナイン)", "en": "Power Pros", "ja": "パワプロ"}, r"パワプロ|power ?pro"),
    Topic("genshin", {"zh-TW": "原神", "en": "Genshin Impact", "ja": "原神"}, r"genshin|原神"),
    Topic("undertale_deltarune", {"zh-TW": "undertale", "en": "Undertale / Deltarune", "ja": "アンダーテール"}, r"undertale|deltarune|アンダーテール"),
    Topic("counter_strike", {"zh-TW": "絕對武力", "en": "Counter-Strike", "ja": "カウンターストライク"}, r"counter-?strike|(?<![a-z0-9])cs ?2(?![a-z0-9])"),
    Topic("raft_game", {"zh-TW": "木筏求生", "en": "Raft", "ja": "Raft"}, r"(?<![a-z])raft(?![a-z])"),
    Topic("tomodachi_life", {"zh-TW": "朋友收藏/MiiLife", "en": "Tomodachi Life", "ja": "トモダチコレクション"}, r"tomodachi ?life|トモダチコレクション|トモコレ"),
    Topic("rainbow_six", {"zh-TW": "虹彩六號", "en": "Rainbow Six Siege", "ja": "レインボーシックス"}, r"rainbow ?six|r6s(?![a-z])|レインボーシックス"),
    Topic("suika_game", {"zh-TW": "西瓜遊戲", "en": "Suika Game", "ja": "スイカゲーム"}, r"スイカゲーム|suika ?game"),
    Topic("geoguessr", {"zh-TW": "GeoGuessr", "en": "GeoGuessr", "ja": "GeoGuessr"}, r"geoguessr"),
    Topic(OTHER_TOPIC, {"zh-TW": "其他", "en": "Other", "ja": "その他"}, None),
)

_PATTERN_BY_LIBRARY_ID: Mapping[str, str] = {topic.id: topic.pattern for topic in PATTERN_LIBRARY if topic.pattern}

# Catalog ids whose curated pattern is filed in the library under a different id: ONLY pairs with identical labels, i.e. the same
# game (R.E.P.O., ARK, watch-along). Pairs that differ in scope (pokemon_sv vs pokemon, mario_kart_8dx vs mario_kart, undertale vs
# undertale_deltarune, ...) are deliberately NOT mapped -- guessing would change what a topic means.
CATALOG_PATTERN_SOURCE: Mapping[str, str] = {
    "repo": "repo_game",
    "ark": "ark_survival",
    "watch_along": "watchalong",
}

# The pre-catalog production taxonomy; every id is in the approved GLOBAL catalog. Used only when the catalog has never been readable.
FALLBACK_TOPIC_IDS: tuple[str, ...] = ("valorant", "sf6", "apex", "minecraft", "singing", "mv", "chatting", OTHER_TOPIC)

CATALOG_TTL_SECONDS = 300.0
CATALOG_RETRY_SECONDS = 30.0


class Taxonomy(NamedTuple):
    topics: tuple[Topic, ...]  # display / match-precedence order
    ids: frozenset[str]
    compiled: tuple[tuple[str, "re.Pattern[str]"], ...]  # (topic id, pattern) for the topics that have one, in precedence order
    source: str  # "catalog" or "fallback"


def _fallback_topic(topic_id: str) -> Topic:
    return next(topic for topic in PATTERN_LIBRARY if topic.id == topic_id)


def _other_topic() -> Topic:
    return _fallback_topic(OTHER_TOPIC)


def _assemble(topics: list[Topic], source: str) -> Taxonomy:
    if not any(topic.id == OTHER_TOPIC for topic in topics):
        topics.append(_other_topic())  # the unclassifiable bucket must always exist, even if a catalog edit dropped it
    compiled = tuple((topic.id, re.compile(topic.pattern)) for topic in topics if topic.pattern)
    return Taxonomy(tuple(topics), frozenset(topic.id for topic in topics), compiled, source)


def build_taxonomy(items: Iterable[Mapping[str, Any]]) -> Taxonomy:
    """The taxonomy of catalog GLOBAL records: ids, labels and aliases from the records, ordered by their `display_order`; the
    curated pattern (if any) from the library. Raises ValueError when the records hold no usable topic."""
    rows = [item for item in items if isinstance(item.get("topic_tag"), str) and item["topic_tag"]]
    if not rows:
        raise ValueError("the topic catalog has no usable GLOBAL topics")

    def order(item: Mapping[str, Any]) -> tuple[int, str]:
        try:
            return int(item.get("display_order")), item["topic_tag"]
        except (TypeError, ValueError):
            return 10**9, item["topic_tag"]

    topics: list[Topic] = []
    seen: set[str] = set()
    for item in sorted(rows, key=order):
        tag = item["topic_tag"]
        if tag in seen:
            continue
        seen.add(tag)
        labels = {
            "zh-TW": item.get("topic_zh") or tag,
            "en": item.get("topic_en") or tag,
            "ja": item.get("topic_ja") or tag,
        }
        pattern = None if tag == OTHER_TOPIC else _PATTERN_BY_LIBRARY_ID.get(CATALOG_PATTERN_SOURCE.get(tag, tag))
        aliases = tuple(alias for alias in (item.get("search_aliases") or ()) if isinstance(alias, str))
        legacy = item.get("legacy_label")
        topics.append(Topic(tag, labels, pattern, aliases, legacy if isinstance(legacy, str) else None))
    return _assemble(topics, "catalog")


def fallback_taxonomy() -> Taxonomy:
    return _assemble([_fallback_topic(topic_id) for topic_id in FALLBACK_TOPIC_IDS], "fallback")


CatalogLoader = Callable[[], "list[Mapping[str, Any]]"]
_loader: CatalogLoader | None = None
_lock = threading.Lock()
_cached: Taxonomy | None = None
_expires_at = 0.0


def set_catalog_loader(loader: CatalogLoader | None) -> None:
    """Replace how the GLOBAL records are read (None = the real DynamoDB table) and drop the cache. Tests only."""
    global _loader
    _loader = loader
    reset_taxonomy_cache()


def reset_taxonomy_cache() -> None:
    global _cached, _expires_at
    with _lock:
        _cached = None
        _expires_at = 0.0


def _load_items() -> list[Mapping[str, Any]]:
    if _loader is not None:
        return _loader()
    from stores.topic_catalog_store import query_global_topics  # lazy: keeps this module importable without boto3 configuration

    return query_global_topics()


def current_taxonomy() -> Taxonomy:
    """The live taxonomy. Cached for CATALOG_TTL_SECONDS; when a refresh fails the last good copy keeps serving (retried after
    CATALOG_RETRY_SECONDS), and if the catalog has never been readable the pre-catalog fallback taxonomy is used -- a transient
    DynamoDB problem must never break classification, validation or GET /topics."""
    global _cached, _expires_at
    now = time.monotonic()
    cached = _cached
    if cached is not None and now < _expires_at:
        return cached
    with _lock:
        now = time.monotonic()
        if _cached is not None and now < _expires_at:
            return _cached
        try:
            _cached = build_taxonomy(_load_items())
            _expires_at = now + CATALOG_TTL_SECONDS
        except Exception as exc:  # noqa: BLE001 -- fail-safe by design, see the docstring
            print(f"Warning: the topic catalog could not be read ({exc}); using {'the last good copy' if _cached else 'the fallback taxonomy'}")
            if _cached is None:
                _cached = fallback_taxonomy()
            _expires_at = now + CATALOG_RETRY_SECONDS
        return _cached


class LiveSet(AbstractSet[str]):
    """A read-only set whose members are recomputed from the live taxonomy on every use, so module-level constants such as TOPIC_IDS
    always follow the catalog (a plain frozenset would freeze the ids at import time)."""

    def __init__(self, supplier: Callable[[], Iterable[str]]):
        self._supplier = supplier

    def __contains__(self, item: object) -> bool:
        return item in frozenset(self._supplier())

    def __iter__(self) -> Iterator[str]:
        return iter(frozenset(self._supplier()))

    def __len__(self) -> int:
        return len(frozenset(self._supplier()))

    @classmethod
    def _from_iterable(cls, it: Iterable[str]) -> frozenset[str]:
        return frozenset(it)

    def __repr__(self) -> str:
        return f"LiveSet({sorted(self)!r})"


class _TopicsView(Sequence[Topic]):
    """`TOPICS`: the live taxonomy's topics, in display order, as a read-only sequence."""

    def __getitem__(self, index):  # type: ignore[override]
        return current_taxonomy().topics[index]

    def __len__(self) -> int:
        return len(current_taxonomy().topics)

    def __iter__(self) -> Iterator[Topic]:
        return iter(current_taxonomy().topics)


TOPICS = _TopicsView()
TOPIC_IDS = LiveSet(lambda: current_taxonomy().ids)


def classify_video_topic(title: str) -> str:
    """Return the single primary topic id for a video title, `other` when nothing matches."""
    normalized = unicodedata.normalize("NFKC", title).casefold()
    return next((topic_id for topic_id, pattern in current_taxonomy().compiled if pattern.search(normalized)), OTHER_TOPIC)


def topics_matching_text(text: str) -> frozenset[str]:
    """Every topic id whose classification pattern matches `text` (NFKC + casefold normalized first, the same convention
    classify_video_topic uses) -- the UNION of every match, not just the single primary topic."""
    normalized = unicodedata.normalize("NFKC", text).casefold()
    return frozenset(topic_id for topic_id, pattern in current_taxonomy().compiled if pattern.search(normalized))


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
