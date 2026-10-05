"""A creator whose official YouTube uploads playlist is gone has no historical catalog and never will: Home's per-creator
reads answer 404 HISTORICAL_DATA_UNAVAILABLE for it, never the generic 503 RANKING_NOT_READY. Everything else keeps its
existing behaviour -- a stored result is always served, and any other creator with no result is still 503."""

from __future__ import annotations

import json

import pytest

from api import api_handler, read_api
from tracking.creator_master import HISTORICAL_DATA_UNAVAILABLE_CREATOR_IDS, load_creators

REPORT_DATE = "2026-10-05"
UNAVAILABLE = ("mano_aloe", "uruha_rushia", "yozora_mel")


class _Store:
    def __init__(self, payloads: dict[str, dict]):
        self.payloads = payloads

    def read_result(self, report_date, creator_id):
        return self.payloads.get(creator_id)


def _wire(monkeypatch, payloads: dict[str, dict] | None = None) -> None:
    store = _Store(payloads or {})

    class _StoreClass:
        @classmethod
        def from_environment_or_default(cls, *, s3_client=None):
            return store

    monkeypatch.setattr(read_api, "S3VideoRankingStore", _StoreClass)


def _event(route: str, creator_id: str) -> dict:
    return {
        "routeKey": {
            "recent": "GET /creators/{creatorId}/videos/recent",
            "ranking": "GET /creators/{creatorId}/videos/ranking",
            "status": "GET /creators/{creatorId}/oshi-status",
        }[route],
        "pathParameters": {"creatorId": creator_id},
        "queryStringParameters": {"reportDate": REPORT_DATE, **({"metric": "total"} if route == "ranking" else {})},
    }


def test_the_known_source_unavailable_creators_are_exactly_these_three_graduated_members():
    assert HISTORICAL_DATA_UNAVAILABLE_CREATOR_IDS == frozenset(UNAVAILABLE)
    by_id = {creator.creator_id: creator for creator in load_creators()}
    for creator_id in UNAVAILABLE:
        assert by_id[creator_id].lifecycle_stage == "graduated" and by_id[creator_id].channel_type == "member"


@pytest.mark.parametrize("creator_id", UNAVAILABLE)
@pytest.mark.parametrize("route", ["recent", "ranking", "status"])
def test_a_source_unavailable_creator_is_a_404_with_a_domain_code(monkeypatch, creator_id, route):
    _wire(monkeypatch)

    response = api_handler.lambda_handler(_event(route, creator_id), None)

    assert response["statusCode"] == 404
    body = json.loads(response["body"])
    assert body["code"] == "HISTORICAL_DATA_UNAVAILABLE"
    assert creator_id in body["error"]


@pytest.mark.parametrize("route", ["recent", "ranking", "status"])
def test_any_other_creator_with_no_result_is_still_the_generic_503_not_ready(monkeypatch, route):
    _wire(monkeypatch)

    response = api_handler.lambda_handler(_event(route, "nanashi_mumei"), None)

    assert response["statusCode"] == 503
    assert json.loads(response["body"])["code"] == "RANKING_NOT_READY"


def test_a_stored_result_for_a_source_unavailable_creator_is_still_served(monkeypatch):
    _wire(monkeypatch, {"mano_aloe": {"reportDate": REPORT_DATE, "creatorId": "mano_aloe", "generatedAt": "g", "videos": []}})

    response = api_handler.lambda_handler(_event("recent", "mano_aloe"), None)

    assert response["statusCode"] == 200
    assert json.loads(response["body"])["videos"] == []


def test_an_unexpected_failure_for_a_source_unavailable_creator_is_still_a_500(monkeypatch):
    class _Boom:
        @classmethod
        def from_environment_or_default(cls, *, s3_client=None):
            raise RuntimeError("s3 exploded")

    monkeypatch.setattr(read_api, "S3VideoRankingStore", _Boom)

    response = api_handler.lambda_handler(_event("recent", "mano_aloe"), None)

    assert response["statusCode"] == 500


def test_an_unknown_creator_is_still_a_client_error_not_a_data_unavailable(monkeypatch):
    _wire(monkeypatch)

    response = api_handler.lambda_handler(_event("recent", "no_such_creator"), None)

    assert response["statusCode"] == 400
