import json

from api import dashboard_catalog_api
from api.api_handler import lambda_handler


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


def test_topics_returns_the_canonical_list_in_display_order():
    response = lambda_handler(_event("GET /topics"), None)

    assert response["statusCode"] == 200
    assert response["headers"]["Content-Type"] == "application/json"
    assert _body(response) == {
        "topics": [
            {"id": "valorant", "label": "VALORANT", "labels": {"zh-TW": "VALO", "en": "VALO", "ja": "VALO"}},
            {"id": "sf6", "label": "SF6", "labels": {"zh-TW": "SF6", "en": "SF6", "ja": "SF6"}},
            {"id": "apex", "label": "APEX", "labels": {"zh-TW": "Apex", "en": "Apex", "ja": "Apex"}},
            {"id": "minecraft", "label": "Minecraft", "labels": {"zh-TW": "Minecraft", "en": "Minecraft", "ja": "Minecraft"}},
            {"id": "singing", "label": "Singing", "labels": {"zh-TW": "歌回", "en": "Singing", "ja": "歌枠"}},
            {"id": "mv", "label": "MV", "labels": {"zh-TW": "MV", "en": "MV", "ja": "MV"}},
            {"id": "chatting", "label": "Chatting", "labels": {"zh-TW": "雜談", "en": "Chatting", "ja": "雑談"}},
            {"id": "other", "label": "Other", "labels": {"zh-TW": "其他", "en": "Other", "ja": "その他"}},
        ]
    }


def test_topics_label_matches_the_endpoints_pre_labels_contract_byte_for_byte():
    """`label` is additive-only backward compatibility (see
    dashboard_catalog_api._LEGACY_TOPIC_LABELS) -- this pins it to the exact
    strings the endpoint returned before `labels` existed, independently of
    the display-order assertion above, so a future refactor of that assertion
    can't accidentally stop covering this compatibility guarantee."""
    response = lambda_handler(_event("GET /topics"), None)
    labels_by_id = {topic["id"]: topic["label"] for topic in _body(response)["topics"]}

    assert labels_by_id == {
        "valorant": "VALORANT",
        "sf6": "SF6",
        "apex": "APEX",
        "minecraft": "Minecraft",
        "singing": "Singing",
        "mv": "MV",
        "chatting": "Chatting",
        "other": "Other",
    }


def test_topics_label_is_never_the_frontends_source_and_falls_back_safely_for_an_unmapped_future_topic(monkeypatch):
    """A topic added after `labels` existed has no historical `label` to preserve --
    confirms the fallback (English label, else id) rather than a KeyError."""
    import api.dashboard_catalog_api as dashboard_catalog_api
    from tracking.video_topics import Topic

    monkeypatch.setattr(
        dashboard_catalog_api,
        "TOPICS",
        (Topic("asmr", {"zh-TW": "ASMR", "en": "ASMR", "ja": "ASMR"}, None),),
    )

    response = lambda_handler(_event("GET /topics"), None)
    assert _body(response) == {"topics": [{"id": "asmr", "label": "ASMR", "labels": {"zh-TW": "ASMR", "en": "ASMR", "ja": "ASMR"}}]}


def test_topics_needs_no_storage_and_is_stable_across_calls(monkeypatch):
    monkeypatch.delenv("YOBI_STORAGE_BACKEND", raising=False)

    assert dashboard_catalog_api.get_topics() == dashboard_catalog_api.get_topics({"ignored": "x"})
