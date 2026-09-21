import json

from api import comparison_api
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


def test_chart_catalog_never_lists_comparison_items():
    chart_ids = {chart["chartDefinitionId"] for chart in dashboard_catalog_api.get_chart_catalog()["charts"]}
    item_ids = {item["comparisonItemId"] for item in dashboard_catalog_api.get_comparison_items()["comparisonItems"]}

    assert chart_ids.isdisjoint(item_ids)


def test_chart_catalog_exposes_only_the_fields_the_add_ui_needs():
    for chart in dashboard_catalog_api.get_chart_catalog()["charts"]:
        assert set(chart) == {"chartDefinitionId", "title"}


def test_unsupported_method_or_path_on_the_catalog_is_a_404():
    assert lambda_handler(_event("POST /dashboard/chart-catalog"), None)["statusCode"] == 404
    assert lambda_handler(_event("GET /dashboard/chart-catalogs"), None)["statusCode"] == 404
    assert lambda_handler(_event("DELETE /dashboard/comparison-items"), None)["statusCode"] == 404


# --- GET /dashboard/comparison-items ---------------------------------------


def test_comparison_items_returns_200_with_the_backend_defined_items():
    response = lambda_handler(_event("GET /dashboard/comparison-items"), None)

    assert response["statusCode"] == 200
    assert _body(response) == {
        "comparisonItems": [
            {"comparisonItemId": "daily-view-growth", "label": "Daily view growth"},
            {"comparisonItemId": "total-views", "label": "Total views"},
        ]
    }


def test_comparison_items_are_stable_unique_and_deterministic():
    first = _body(lambda_handler(_event("GET /dashboard/comparison-items"), None))
    second = _body(lambda_handler(_event("GET /dashboard/comparison-items"), None))
    ids = [item["comparisonItemId"] for item in first["comparisonItems"]]

    assert first == second
    assert len(ids) == len(set(ids))


def test_every_comparison_item_maps_to_a_real_computed_metric():
    for item in dashboard_catalog_api.COMPARISON_ITEMS:
        assert item.metric in comparison_api.METRICS
        assert item.description


def test_no_unsupported_mock_item_is_returned():
    ids = {item["comparisonItemId"] for item in dashboard_catalog_api.get_comparison_items()["comparisonItems"]}

    assert ids.isdisjoint({"revenue", "engagement", "growth"})
    # Every metric the backend can compute is exposed as exactly one item, and vice versa.
    assert {item.metric for item in dashboard_catalog_api.COMPARISON_ITEMS} == set(comparison_api.METRICS)


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
