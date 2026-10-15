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
