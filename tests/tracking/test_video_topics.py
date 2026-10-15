import pytest

from tracking.video_topics import OTHER_TOPIC, TOPIC_IDS, TOPICS, classify_video_topic, resolve_video_topics, topics_matching_text


def test_taxonomy_ids_and_order_are_stable():
    assert [topic.id for topic in TOPICS] == [
        "valorant", "sf6", "apex", "minecraft", "singing", "mv", "chatting",
        # Topic Discovery batch 1 (scripts/analysis/proposed_topic_classification.py) --
        # inserted strictly after the original 7, strictly before "other".
        "dance_cover", "pokemon", "ark_survival", "watchalong", "monster_hunter", "league_of_legends",
        "mario_kart", "grand_theft_auto", "rust", "resident_evil", "super_mario_platformer", "splatoon", "dragon_quest",
        "elden_ring", "overwatch", "asmr", "final_fantasy", "repo_game", "among_us", "zelda", "yakuza",
        "seven_days_to_die_survival", "holocure", "pubg", "phasmophobia", "call_of_duty", "tokkomachi", "uma_musume",
        "mahjong", "fall_guys", "asobi_taizen", "persona", "dead_by_daylight", "superchat_reading", "tarkov",
        "palworld", "lethal_company", "shadowverse", "animal_crossing", "tetris_puyo", "power_pro", "genshin",
        "undertale_deltarune", "counter_strike", "raft_game", "tomodachi_life", "rainbow_six", "suika_game",
        "geoguessr",
        "other",
    ]
    assert TOPIC_IDS == {topic.id for topic in TOPICS}
    assert OTHER_TOPIC == "other"


def test_every_topic_has_a_label_for_every_frontend_locale():
    for topic in TOPICS:
        assert set(topic.labels) == {"zh-TW", "en", "ja"}
        assert all(isinstance(label, str) and label for label in topic.labels.values())


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("【VALORANT】ランク", "valorant"),
        ("valorant scrims", "valorant"),
        ("ヴァロラント配信", "valorant"),
        ("バロラント配信", "valorant"),
        ("ヴァロやる", "valorant"),
        ("【VALO】カスタム", "valorant"),
        ("Street Fighter 6 ranked", "sf6"),
        ("STREET FIGHTER 6", "sf6"),
        ("streetfighter6", "sf6"),
        ("SF6 ランクマ", "sf6"),
        ("スト6 マスター", "sf6"),
        ("ストリートファイター6", "sf6"),
        ("ストリートファイターⅥ", "sf6"),
        ("APEX ランク", "apex"),
        ("Apex Legends duo", "apex"),
        ("ApexLegends", "apex"),
        ("エーペックス配信", "apex"),
        ("エペ参加型", "apex"),
        ("Minecraft survival", "minecraft"),
        ("MINECRAFT", "minecraft"),
        ("マイクラ建築", "minecraft"),
        ("マインクラフト", "minecraft"),
        ("【歌枠】新曲", "singing"),
        ("歌回です", "singing"),
        ("karaoke stream", "singing"),
        ("カラオケ配信", "singing"),
        ("Singing stream", "singing"),
        ("Cover", "mv"),
        ("【Cover】新曲", "mv"),
        ("歌ってみた", "mv"),
        ("【歌ってみた】新曲", "mv"),
        ("【歌ってみた】空月の歌", "mv"),
        ("歌配信", "singing"),
        ("歌枠 Cover 配信", "singing"),
        ("singing livestream", "singing"),
        ("covered", "mv"),
        ("MV", "mv"),
        ("Music Video", "mv"),
        ("オリジナル曲", "mv"),
        ("Original Song", "mv"),
        ("原創曲", "mv"),
        ("原創歌曲", "mv"),
        ("【雑談】おはよう", "chatting"),
        ("雑談配信", "chatting"),
        ("just chatting", "chatting"),
        ("free talk", "chatting"),
        ("zatsudan", "chatting"),
    ],
)
def test_aliases_map_to_their_topic(title, expected):
    assert classify_video_topic(title) == expected


def test_uploaded_cover_is_mv():
    assert classify_video_topic("【歌ってみた】新曲 covered by 白上フブキ") == "mv"


@pytest.mark.parametrize("title", ["", "   ", "unrelated title", "料理配信", "Weekly update"])
def test_unmatched_or_empty_titles_are_other(title):
    assert classify_video_topic(title) == "other"


@pytest.mark.parametrize(
    "title",
    [
        "空月の歌",  # bare 歌 only -- must not become singing or mv
        "歌うことが好き",  # bare 歌 only, different inflection
        "my original idea",  # bare "original" alone must not trigger mv
        "today's song request",  # bare "song" alone must not trigger mv
        "music corner chat",  # bare "music" alone must not trigger mv
    ],
)
def test_bare_uta_and_generic_music_words_are_not_singing_or_mv(title):
    assert classify_video_topic(title) == "other"


def test_full_width_and_case_are_normalized():
    assert classify_video_topic("ＶＡＬＯＲＡＮＴ") == "valorant"
    assert classify_video_topic("ｓｆ６") == "sf6"
    assert classify_video_topic("ＭｉｎｅＣｒａｆｔ") == "minecraft"
    assert classify_video_topic("ﾏｲｸﾗ") == "minecraft"  # NFKC folds half-width katakana


@pytest.mark.parametrize(
    "title",
    [
        "valorousness",  # contains no whole-word valo
        "ヴァローナ",  # katakana continues after ヴァロ
        "ストレス6",  # スト preceded by katakana
        "スト5",
        "SF66",
        "sf60",
        "apexes",
        "エペレスト登山",  # エペ followed by katakana
        "chat room",
        "chattingly",
        "Street Fighter 60",
    ],
)
def test_false_positive_sensitive_titles(title):
    assert classify_video_topic(title) == "other"


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("【VALORANT】歌枠", "valorant"),  # game beats singing
        ("SF6 雑談", "sf6"),  # game beats chatting
        ("歌枠 雑談", "singing"),  # singing beats chatting
        ("VALORANT × APEX", "valorant"),  # earlier canonical game wins
        ("Apex vs Minecraft", "apex"),
        ("マイクラ SF6", "sf6"),
        ("【歌ってみた】Cover", "mv"),  # 歌ってみた is a music work (mv), never livestream singing
        ("APEX Cover", "apex"),  # game beats mv, same precedence family as game beats singing/chatting
        ("歌枠 MV", "singing"),  # singing beats mv
        ("MV 雑談", "mv"),  # mv beats chatting
    ],
)
def test_multi_match_precedence_follows_canonical_order(title, expected):
    assert classify_video_topic(title) == expected


# --- resolve_video_topics (Topic Phase 3 missing-topic fallback) -----------


def test_resolve_video_topics_uses_the_persisted_topic_when_present():
    items = [{"videoId": "v1", "title": "anything", "topic": "singing"}]
    assert resolve_video_topics(items) == {"v1": "singing"}


def test_resolve_video_topics_classifies_from_title_when_topic_is_missing():
    """The live topic backfill has not necessarily run -- an old Video Master
    record with no `topic` attribute at all must still resolve, classified
    in memory from its stored title."""
    items = [{"videoId": "v1", "title": "【VALORANT】ランク", "topic": None}]
    assert resolve_video_topics(items) == {"v1": "valorant"}


def test_resolve_video_topics_handles_a_dynamodb_item_with_no_topic_key_at_all():
    """A raw BatchGetItem/scan result for a pre-topic-field record has no
    `topic` key whatsoever (dynamodb_store._to_raw omits it entirely when
    None) -- .get("topic") must still work, not raise KeyError."""
    items = [{"videoId": "v1", "title": "雑談配信"}]
    assert resolve_video_topics(items) == {"v1": "chatting"}


def test_resolve_video_topics_covers_every_item_independently():
    items = [
        {"videoId": "v1", "title": "t1", "topic": "apex"},
        {"videoId": "v2", "title": "unmatched nonsense title", "topic": None},
        {"videoId": "v3", "title": "マイクラ実況", "topic": None},
    ]
    assert resolve_video_topics(items) == {"v1": "apex", "v2": OTHER_TOPIC, "v3": "minecraft"}


def test_resolve_video_topics_rejects_a_persisted_invalid_topic_and_reclassifies():
    """A corrupted/stale/manually-edited persisted `topic` that isn't one of
    the canonical TOPIC_IDS must never leak through unchanged -- it falls
    back to in-memory classification exactly like a missing topic would."""
    items = [{"videoId": "v1", "title": "【VALORANT】ランク", "topic": "not_a_real_topic"}]
    assert resolve_video_topics(items) == {"v1": "valorant"}


def test_resolve_video_topics_handles_a_missing_title_key_safely():
    """No `title` key at all (not even None) -- must classify to OTHER_TOPIC,
    never raise KeyError."""
    items = [{"videoId": "v1", "topic": None}]
    assert resolve_video_topics(items) == {"v1": OTHER_TOPIC}


def test_resolve_video_topics_handles_an_empty_title_safely():
    items = [{"videoId": "v1", "title": "", "topic": None}]
    assert resolve_video_topics(items) == {"v1": OTHER_TOPIC}


def test_resolve_video_topics_handles_a_none_title_safely():
    items = [{"videoId": "v1", "title": None, "topic": None}]
    assert resolve_video_topics(items) == {"v1": OTHER_TOPIC}


class TestTopicsMatchingText:
    """topics_matching_text powers Video Search's canonical-topic resolution (src/search/video_search.py):
    unlike classify_video_topic (one primary topic per title), it returns every topic whose pattern
    matches, since a search query may legitimately resolve to more than one topic."""

    def test_resolves_a_short_form_alias_the_same_way_classify_video_topic_does(self):
        assert topics_matching_text("VALO") == {"valorant"}
        assert topics_matching_text("エペ") == {"apex"}
        assert topics_matching_text("雑談") == {"chatting"}

    def test_is_case_insensitive_and_nfkc_normalizing_like_classify_video_topic(self):
        assert topics_matching_text("valo") == {"valorant"}
        assert topics_matching_text("ＳＦ６") == {"sf6"}  # full-width "SF6"

    def test_returns_an_empty_set_for_text_matching_no_topic(self):
        assert topics_matching_text("completely unrelated text") == frozenset()

    def test_other_topic_has_no_pattern_and_never_matches(self):
        assert OTHER_TOPIC not in topics_matching_text("其他 other 任何文字")
