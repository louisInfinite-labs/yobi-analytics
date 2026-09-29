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
            {"chartDefinitionId": "kpi-summary", "title": "KPI Summary"},
            {"chartDefinitionId": "growth-bar-chart", "title": "Growth Bar Chart"},
            {"chartDefinitionId": "contribution-ring", "title": "Channel Contribution"},
            {"chartDefinitionId": "ranking", "title": "Rankings"},
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
            {"id": "valorant", "label": "VALORANT"},
            {"id": "sf6", "label": "SF6"},
            {"id": "apex", "label": "APEX"},
            {"id": "minecraft", "label": "Minecraft"},
            {"id": "singing", "label": "Singing"},
            {"id": "chatting", "label": "Chatting"},
            {"id": "other", "label": "Other"},
        ]
    }


def test_topics_needs_no_storage_and_is_stable_across_calls(monkeypatch):
    monkeypatch.delenv("YOBI_STORAGE_BACKEND", raising=False)

    assert dashboard_catalog_api.get_topics() == dashboard_catalog_api.get_topics({"ignored": "x"})
