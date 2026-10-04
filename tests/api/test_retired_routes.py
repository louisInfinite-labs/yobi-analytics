"""Compatibility tests for the five routes retired by the ranking simplification (R7/R8B/R9).

The API Gateway routes stay, so deploying the new API Lambda must not turn them into 404s: each answers a
deterministic 410 `ENDPOINT_RETIRED` with a `replacement` hint, touches no store, and never echoes request input.
"""

import json

import pytest

from api import api_handler

RETIRED = {
    "GET /creators/{creatorId}/trending": "GET /creators/{creatorId}/videos/ranking",
    "GET /organizations/{organization}/trending": None,
    "GET /leaderboard": None,
    "GET /organizations/{organization}/leaderboard": None,
    "GET /topics/{topic}/leaderboard": None,
}


def _call(route_key, **event_fields):
    return api_handler.lambda_handler({"routeKey": route_key, **event_fields}, None)


@pytest.mark.parametrize(("route_key", "replacement"), sorted(RETIRED.items()))
def test_each_retired_route_answers_410_with_a_stable_machine_readable_body(route_key, replacement):
    response = _call(route_key)

    assert response["statusCode"] == 410  # never the generic 404 "No such route", never a 5xx
    assert response["headers"]["Content-Type"] == "application/json"
    body = json.loads(response["body"])
    assert body["code"] == "ENDPOINT_RETIRED"
    assert body["replacement"] == replacement
    assert route_key in body["error"]


def test_the_retired_set_matches_exactly_the_five_legacy_gateway_routes():
    assert api_handler._RETIRED_ROUTES == RETIRED


def test_retired_routes_never_reach_a_data_handler_or_echo_request_input(monkeypatch):
    def _boom(*args, **kwargs):
        raise AssertionError("a retired route must not touch any store")

    for name in ("get_video_growth", "get_subscriber_leaderboard", "get_video_ranking"):
        monkeypatch.setattr(api_handler.read_api, name, _boom)

    response = _call(
        "GET /organizations/{organization}/leaderboard",
        pathParameters={"organization": "<script>alert(1)</script>"},
        queryStringParameters={"period": "7d"},
    )

    assert response["statusCode"] == 410
    assert "<script>" not in response["body"]


def test_an_unknown_route_is_still_a_plain_404():
    response = _call("GET /definitely/not/a/route")

    assert response["statusCode"] == 404
    assert "No such route" in json.loads(response["body"])["error"]


def test_the_new_routes_are_unaffected_by_the_retired_handling():
    for route_key in (
        "GET /subscribers/leaderboard",
        "GET /creators/{creatorId}/videos/ranking",
        "GET /creators/{creatorId}/videos/recent",
        "GET /creators/{creatorId}/oshi-status",
        "GET /dashboard/chart-catalog",
    ):
        assert route_key in api_handler._ROUTES
        assert route_key not in api_handler._RETIRED_ROUTES
