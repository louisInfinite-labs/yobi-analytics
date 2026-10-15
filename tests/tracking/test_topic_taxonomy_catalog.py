"""The topic taxonomy follows the Topic Catalog (DynamoDB YobiTopicCatalog, GLOBAL partition) -- see tracking.video_topics.

The default catalog in tests is tests/fixtures/topic_catalog_global.json, a snapshot of production GLOBAL (52 topics)."""

from __future__ import annotations

import pytest

from tests.conftest import load_global_topic_catalog_fixture
from tracking import video_topics
from tracking.video_topics import (
    CATALOG_PATTERN_SOURCE,
    CATALOG_TTL_SECONDS,
    FALLBACK_TOPIC_IDS,
    OTHER_TOPIC,
    PATTERN_LIBRARY,
    TOPIC_IDS,
    TOPICS,
    LiveSet,
    build_taxonomy,
    classify_video_topic,
    current_taxonomy,
    resolve_video_topics,
    set_catalog_loader,
)


def _item(tag, order, zh=None, en=None, ja=None, aliases=(), legacy=None):
    item = {"catalog_id": "GLOBAL", "topic_tag": tag, "display_order": order, "topic_zh": zh or tag, "topic_en": en or tag, "topic_ja": ja or tag, "search_aliases": list(aliases)}
    if legacy:
        item["legacy_label"] = legacy
    return item


GLOBAL_IDS = [item["topic_tag"] for item in sorted(load_global_topic_catalog_fixture(), key=lambda item: item["display_order"])]


# --- every GLOBAL id is a valid id everywhere -------------------------------------------------------------------------------------


def test_every_global_topic_id_is_accepted_not_only_the_ones_the_code_knows():
    assert len(GLOBAL_IDS) == 52
    for topic_id in GLOBAL_IDS:  # includes ids the classifier has no pattern for: repo, peak, 誕生日, 3d, 生放送, 告知, ...
        assert topic_id in TOPIC_IDS
    assert "pokemon" not in TOPIC_IDS and "repo_game" not in TOPIC_IDS  # code-library ids that are not in the catalog are NOT valid


def test_ranking_scopes_and_reminder_scopes_follow_the_catalog_live():
    from analytics.video_ranking import VALID_TOPIC_SCOPES
    from notifications.live_reminder import REMINDER_TOPIC_IDS

    assert VALID_TOPIC_SCOPES == frozenset(GLOBAL_IDS) | {"all"}
    assert REMINDER_TOPIC_IDS == frozenset(GLOBAL_IDS) - {OTHER_TOPIC}
    assert "誕生日" in VALID_TOPIC_SCOPES and "誕生日" in REMINDER_TOPIC_IDS

    set_catalog_loader(lambda: [_item("valorant", 0), _item("other", 1), _item("new_game", 2)])
    assert "new_game" in VALID_TOPIC_SCOPES and "new_game" in REMINDER_TOPIC_IDS  # a constant imported at module load still sees the change
    assert "peak" not in VALID_TOPIC_SCOPES


def test_topic_validation_in_the_read_api_accepts_a_catalog_only_topic():
    from analytics.video_ranking import VALID_TOPIC_SCOPES

    for topic_id in ("repo", "ark", "pokemon_sv", "誕生日", "3d", "告知"):
        assert topic_id in VALID_TOPIC_SCOPES  # these used to be HTTP 400 against the code-defined taxonomy


# --- patterns: curated, only for catalog topics, aliases are search-only ----------------------------------------------------------


def test_classification_only_ever_returns_catalog_ids():
    for title in ("【VALORANT】ランク", "Minecraft 建築", "歌枠 karaoke", "ポケモン対戦", "R.E.P.O. 実況", "雑談"):
        assert classify_video_topic(title) in TOPIC_IDS


def test_curated_patterns_apply_to_catalog_ids_that_have_one():
    assert classify_video_topic("【Phasmophobia】怖い") == "phasmophobia"
    assert classify_video_topic("Among Us 人狼") == "among_us"
    assert classify_video_topic("Lethal Company 同期") == "lethal_company"


def test_label_identical_renames_reuse_the_library_pattern_under_the_catalog_id():
    assert CATALOG_PATTERN_SOURCE == {"repo": "repo_game", "ark": "ark_survival", "watch_along": "watchalong"}
    assert classify_video_topic("【R.E.P.O.】みんなで") == "repo"
    assert classify_video_topic("ARK: Survival Evolved 恐竜") == "ark"
    assert classify_video_topic("同時視聴 配信") == "watch_along"


def test_a_library_topic_that_is_not_in_the_catalog_is_never_assigned():
    assert "pokemon" not in TOPIC_IDS
    assert classify_video_topic("ポケモンSV 対戦") == OTHER_TOPIC  # pokemon_sv is in the catalog, but its scope differs from the library's pokemon: unmapped
    assert classify_video_topic("マリオカート 8 Deluxe") == OTHER_TOPIC


def test_search_aliases_never_become_classification_patterns():
    by_id = {topic.id: topic for topic in TOPICS}
    assert "生放送" in by_id["生放送"].search_aliases and by_id["生放送"].pattern is None
    assert by_id["3d"].pattern is None and by_id["誕生日"].pattern is None and by_id["告知"].pattern is None
    assert classify_video_topic("【生放送】3D お披露目 告知") == OTHER_TOPIC  # nothing curated matches: it is NOT filed under 生放送 / 3d / 告知


def test_precedence_is_display_order_and_other_is_never_a_pattern():
    by_id = {topic.id: topic for topic in TOPICS}
    assert by_id[OTHER_TOPIC].pattern is None
    assert classify_video_topic("Minecraft で VALORANT の話") == "valorant"  # valorant (order 0) beats minecraft (order 3)
    set_catalog_loader(lambda: [_item("minecraft", 0), _item("valorant", 1), _item("other", 2)])
    assert classify_video_topic("Minecraft で VALORANT の話") == "minecraft"  # reorder the catalog -> the precedence follows


def test_labels_aliases_and_legacy_label_come_from_the_catalog_record_not_the_code_library():
    set_catalog_loader(lambda: [_item("valorant", 0, zh="瓦", en="Val", ja="ヴァロ", aliases=("valo",), legacy="VALORANT"), _item("other", 1)])
    valorant = current_taxonomy().topics[0]
    assert dict(valorant.labels) == {"zh-TW": "瓦", "en": "Val", "ja": "ヴァロ"}
    assert valorant.search_aliases == ("valo",) and valorant.legacy_label == "VALORANT"


# --- stored video topics ----------------------------------------------------------------------------------------------------------


def test_stored_topic_ids_are_reconciled_against_the_catalog_without_a_rewrite():
    rows = [
        {"videoId": "a", "topic": "valorant", "title": "x"},  # a catalog id: kept as stored
        {"videoId": "b", "topic": "peak", "title": "x"},  # a catalog id the classifier cannot produce: still kept (valid id)
        {"videoId": "c", "topic": "pokemon", "title": "ポケモン"},  # not in the catalog: reclassified in memory (-> other), never trusted
        {"videoId": "d", "title": "Minecraft"},  # missing: classified in memory
    ]
    assert resolve_video_topics(rows) == {"a": "valorant", "b": "peak", "c": OTHER_TOPIC, "d": "minecraft"}


# --- caching, refresh and fail-safe -----------------------------------------------------------------------------------------------


def test_the_catalog_is_read_once_per_ttl_and_refreshed_after_it(monkeypatch):
    calls = []
    clock = [1000.0]
    monkeypatch.setattr(video_topics.time, "monotonic", lambda: clock[0])

    def loader():
        calls.append(1)
        return [_item("valorant", 0), _item("other", 1)] + ([_item("added_later", 2)] if len(calls) > 1 else [])

    set_catalog_loader(loader)
    assert "added_later" not in TOPIC_IDS
    for _ in range(5):
        classify_video_topic("x")
        _ = "valorant" in TOPIC_IDS
    assert len(calls) == 1  # one DynamoDB read, not one per call
    clock[0] += CATALOG_TTL_SECONDS + 1
    assert "added_later" in TOPIC_IDS  # a topic added to GLOBAL is picked up within the TTL
    assert len(calls) == 2


def test_a_failed_refresh_keeps_serving_the_last_good_catalog(monkeypatch, capsys):
    clock = [1000.0]
    monkeypatch.setattr(video_topics.time, "monotonic", lambda: clock[0])
    state = {"fail": False}

    def loader():
        if state["fail"]:
            raise RuntimeError("DynamoDB unavailable")
        return [_item("valorant", 0), _item("peak", 1), _item("other", 2)]

    set_catalog_loader(loader)
    assert "peak" in TOPIC_IDS
    state["fail"] = True
    clock[0] += CATALOG_TTL_SECONDS + 1
    assert "peak" in TOPIC_IDS and current_taxonomy().source == "catalog"  # still the last good copy
    assert "could not be read" in capsys.readouterr().out


def test_when_the_catalog_was_never_readable_the_pre_catalog_taxonomy_is_used():
    def loader():
        raise RuntimeError("no table")

    set_catalog_loader(loader)
    taxonomy = current_taxonomy()
    assert taxonomy.source == "fallback"
    assert [topic.id for topic in taxonomy.topics] == list(FALLBACK_TOPIC_IDS)
    assert set(FALLBACK_TOPIC_IDS) <= set(GLOBAL_IDS)  # every fallback id is in the approved catalog
    assert classify_video_topic("VALORANT") == "valorant"


def test_an_empty_catalog_is_treated_as_unreadable_not_as_zero_topics():
    set_catalog_loader(lambda: [])
    assert current_taxonomy().source == "fallback"
    with pytest.raises(ValueError):
        build_taxonomy([])


def test_the_unclassifiable_bucket_always_exists_even_if_the_catalog_lacks_other():
    taxonomy = build_taxonomy([_item("valorant", 0), _item("peak", 1)])
    assert OTHER_TOPIC in taxonomy.ids and taxonomy.topics[-1].id == OTHER_TOPIC


def test_malformed_records_are_skipped_and_ordering_is_robust():
    taxonomy = build_taxonomy([{"topic_tag": ""}, {"nope": 1}, _item("b", "x"), _item("a", 1), _item("a", 2), _item("other", 0)])
    assert [topic.id for topic in taxonomy.topics] == ["other", "a", "b"]  # a duplicate id is dropped; a non-numeric order sorts last


def test_live_set_behaves_like_a_frozenset_for_the_operations_the_code_uses():
    live = LiveSet(lambda: ("a", "b"))
    assert "a" in live and "z" not in live and len(live) == 2 and sorted(live) == ["a", "b"]
    assert live - {"a"} == frozenset({"b"}) and (frozenset({"x"}) | live) == frozenset({"a", "b", "x"})
    assert live == frozenset({"a", "b"})


def test_the_library_holds_only_patterns_the_catalog_may_use_and_never_a_pattern_for_other():
    assert all(topic.pattern is None for topic in PATTERN_LIBRARY if topic.id == OTHER_TOPIC)
