import pytest

from tracking.video_topics import OTHER_TOPIC, TOPIC_IDS, TOPICS, classify_video_topic, resolve_video_topics


def test_taxonomy_ids_labels_and_order_are_stable():
    assert [(topic.id, topic.label) for topic in TOPICS] == [
        ("valorant", "VALORANT"),
        ("sf6", "SF6"),
        ("apex", "APEX"),
        ("minecraft", "Minecraft"),
        ("singing", "Singing"),
        ("chatting", "Chatting"),
        ("other", "Other"),
    ]
    assert TOPIC_IDS == {topic.id for topic in TOPICS}
    assert OTHER_TOPIC == "other"


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
        ("【雑談】おはよう", "chatting"),
        ("雑談配信", "chatting"),
        ("just chatting", "chatting"),
        ("free talk", "chatting"),
        ("zatsudan", "chatting"),
    ],
)
def test_aliases_map_to_their_topic(title, expected):
    assert classify_video_topic(title) == expected


def test_uploaded_cover_is_singing():
    assert classify_video_topic("【歌ってみた】新曲 covered by 白上フブキ") == "singing"


@pytest.mark.parametrize("title", ["", "   ", "unrelated title", "料理配信", "Weekly update"])
def test_unmatched_or_empty_titles_are_other(title):
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
