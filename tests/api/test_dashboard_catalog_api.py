import json

import pytest

from api import dashboard_catalog_api
from api.api_handler import lambda_handler
from tests.conftest import load_global_topic_catalog_fixture
from tracking import video_topics
from tracking.video_topics import FALLBACK_TOPIC_IDS, set_catalog_loader

# GET /topics reads the approved Topic Catalog (DynamoDB YobiTopicCatalog, GLOBAL) through tracking.video_topics' cached taxonomy. In
# tests that catalog is tests/fixtures/topic_catalog_global.json (a snapshot of production) unless a test installs its own loader.

# The pre-`labels` single-string `label` values production has always returned for the original eight topics.
_LEGACY_TOPIC_LABELS = {
    "valorant": "VALORANT",
    "sf6": "SF6",
    "apex": "APEX",
    "minecraft": "Minecraft",
    "singing": "Singing",
    "mv": "MV",
    "chatting": "Chatting",
    "other": "Other",
}

GLOBAL_ITEMS = sorted(load_global_topic_catalog_fixture(), key=lambda item: item["display_order"])


def _event(route_key, *, query=None):
    return {"routeKey": route_key, "queryStringParameters": query, "pathParameters": None, "body": None, "headers": {}}


def _body(response):
    return json.loads(response["body"])


# --- GET /dashboard/chart-catalog -----------------------------------------


def test_chart_catalog_returns_200_with_the_current_addable_charts_in_order():
    response = lambda_handler(_event("GET /dashboard/chart-catalog"), None)

    assert response["statusCode"] == 200
    assert response["headers"]["Content-Type"] == "application/json"
    assert _body(response) == {
        "charts": [
            {"chartDefinitionId": "subscriber-leaderboard", "title": "Subscriber Leaderboard"},
            {"chartDefinitionId": "creator-video-ranking", "title": "Creator Video Ranking"},
        ]
    }


def test_chart_catalog_is_deterministic_across_calls():
    first = lambda_handler(_event("GET /dashboard/chart-catalog"), None)
    second = lambda_handler(_event("GET /dashboard/chart-catalog"), None)

    assert first["body"] == second["body"]


def test_chart_catalog_ids_are_unique_and_non_empty():
    ids = [chart["chartDefinitionId"] for chart in _body(lambda_handler(_event("GET /dashboard/chart-catalog"), None))["charts"]]

    assert len(ids) == len(set(ids))
    assert all(ids)


def test_chart_catalog_exposes_only_the_fields_the_add_ui_needs():
    for chart in dashboard_catalog_api.get_chart_catalog()["charts"]:
        assert set(chart) == {"chartDefinitionId", "title"}


def test_unsupported_method_or_path_on_the_catalog_is_a_404():
    assert lambda_handler(_event("POST /dashboard/chart-catalog"), None)["statusCode"] == 404
    assert lambda_handler(_event("GET /dashboard/chart-catalogs"), None)["statusCode"] == 404


# R8B (AWS Cost Recovery): GET /dashboard/comparison-items/comparison-data
# coverage removed here -- see test_api_gateway_routes.py's own
# test_removed_comparison_routes_are_no_longer_exposed for the route-removal
# regression guard.


# --- GET /topics -------------------------------------------------------------


def test_topics_returns_every_global_catalog_topic_in_display_order():
    response = lambda_handler(_event("GET /topics"), None)

    assert response["statusCode"] == 200
    assert response["headers"]["Content-Type"] == "application/json"
    topics = _body(response)["topics"]
    assert [topic["id"] for topic in topics] == [item["topic_tag"] for item in GLOBAL_ITEMS]
    assert len(topics) == 52
    for topic, item in zip(topics, GLOBAL_ITEMS):
        assert set(topic) == {"id", "label", "labels", "searchAliases"}
        assert topic["labels"] == {"zh-TW": item["topic_zh"], "en": item["topic_en"], "ja": item["topic_ja"]}
        assert topic["searchAliases"] == list(item.get("search_aliases") or [])


def test_topics_includes_the_catalog_topics_the_code_never_defined():
    ids = {topic["id"] for topic in _body(lambda_handler(_event("GET /topics"), None))["topics"]}

    assert {"repo", "ark", "pokemon_sv", "watch_along", "誕生日", "3d", "2d", "生放送", "告知"} <= ids
    assert not ids & {"pokemon", "repo_game", "ark_survival"}  # code-library ids that are not in the catalog


def test_topics_label_for_the_original_eight_matches_the_pre_labels_contract_byte_for_byte():
    topics = dashboard_catalog_api.get_topics()["topics"]

    assert {topic["id"]: topic["label"] for topic in topics[:8]} == _LEGACY_TOPIC_LABELS


def test_topics_label_falls_back_to_the_english_label_then_the_id():
    set_catalog_loader(
        lambda: [
            {"topic_tag": "a", "display_order": 0, "topic_zh": "甲", "topic_en": "Alpha", "topic_ja": "ア", "legacy_label": "OLD"},
            {"topic_tag": "b", "display_order": 1, "topic_zh": "乙", "topic_en": "Beta", "topic_ja": "ベ"},
            {"topic_tag": "c", "display_order": 2},
        ]
    )

    topics = {topic["id"]: topic for topic in dashboard_catalog_api.get_topics()["topics"]}

    assert topics["a"]["label"] == "OLD"
    assert topics["b"]["label"] == "Beta"
    assert topics["c"]["label"] == "c" and topics["c"]["labels"] == {"zh-TW": "c", "en": "c", "ja": "c"}  # missing text falls back to the id
    assert all(isinstance(topic["searchAliases"], list) for topic in topics.values())


def test_topics_follows_a_catalog_change_within_the_ttl_window(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(video_topics.time, "monotonic", lambda: clock[0])
    data = [{"topic_tag": "valorant", "display_order": 0}, {"topic_tag": "other", "display_order": 5}]
    set_catalog_loader(lambda: list(data))
    assert [t["id"] for t in dashboard_catalog_api.get_topics()["topics"]] == ["valorant", "other"]

    data.append({"topic_tag": "added_in_dynamodb", "display_order": 3})
    assert len(dashboard_catalog_api.get_topics()["topics"]) == 2  # still cached
    clock[0] += video_topics.CATALOG_TTL_SECONDS + 1
    assert [t["id"] for t in dashboard_catalog_api.get_topics()["topics"]] == ["valorant", "added_in_dynamodb", "other"]


def test_topics_is_stable_across_calls():
    assert dashboard_catalog_api.get_topics() == dashboard_catalog_api.get_topics()


def test_topics_serves_the_pre_catalog_taxonomy_when_the_catalog_is_unreadable_instead_of_failing():
    def broken():
        raise RuntimeError("table unreachable")

    set_catalog_loader(broken)

    response = lambda_handler(_event("GET /topics"), None)

    assert response["statusCode"] == 200
    assert [topic["id"] for topic in _body(response)["topics"]] == list(FALLBACK_TOPIC_IDS)
