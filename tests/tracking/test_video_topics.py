import pytest

from tracking.video_topics import OTHER_TOPIC, TOPIC_IDS, TOPICS, classify_video_topic


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
