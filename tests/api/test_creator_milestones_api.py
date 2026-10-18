"""Tests for GET /creators/{creatorId}/milestones (read_api.get_creator_milestones and its api_handler route)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from api import api_handler, read_api
from stores import creator_milestones_store as store

_SEED_PATH = Path(__file__).parent.parent.parent / "scripts" / "migration" / "creator_milestones_seed.json"
RECORDS = {row["creatorId"]: row for row in json.loads(_SEED_PATH.read_text(encoding="utf-8"))["records"]}


@pytest.fixture(autouse=True)
def seeded_store(monkeypatch):
    """Serve the real 110-record production dataset from memory: no AWS call is made."""
    monkeypatch.setattr(
        store,
        "get_creator_milestones",
        lambda creator_id: (
            {"creatorId": creator_id, "birthday": RECORDS[creator_id]["birthday"], "debutDate": RECORDS[creator_id]["debutDate"]}
            if creator_id in RECORDS
            else None
        ),
    )


def _call(creator_id: str) -> dict:
    return api_handler.lambda_handler(
        {"routeKey": "GET /creators/{creatorId}/milestones", "pathParameters": {"creatorId": creator_id}}, None
    )


def test_returns_exactly_the_three_fields_for_an_active_creator():
    """The Suisei record comes back as {creatorId, birthday, debutDate} and nothing else."""
    response = _call("hoshimachi_suisei")
    assert response["statusCode"] == 200
    assert json.loads(response["body"]) == {"creatorId": "hoshimachi_suisei", "birthday": "03-22", "debutDate": "2018-03-22"}


def test_graduated_creator_is_served_with_the_original_debut_date():
    """A graduated creator (mano_aloe, graduated 2020-08-31) keeps her 2020-08-15 debut."""
    body = json.loads(_call("mano_aloe")["body"])
    assert (body["birthday"], body["debutDate"]) == ("10-28", "2020-08-15")


def test_creator_id_is_matched_exactly_not_by_name():
    """Each id returns its own record, and a Feb 29 birthday is served as stored."""
    assert json.loads(_call("kaga_sumire")["body"])["creatorId"] == "kaga_sumire"
    assert json.loads(_call("kaga_nazuna")["body"])["creatorId"] == "kaga_nazuna"
    assert json.loads(_call("hakos_baelz")["body"])["birthday"] == "02-29"


def test_unknown_creator_is_a_404():
    """A creatorId Creator Master does not know is a clean 404."""
    assert _call("not_a_creator")["statusCode"] == 404


def test_known_creator_without_a_record_is_a_404():
    """A real channel (a group) with no milestones record is a 404, not an empty body."""
    assert _call("vspo_official")["statusCode"] == 404


def test_missing_creator_id_is_a_400():
    """No creatorId at all is a client error."""
    response = api_handler.lambda_handler({"routeKey": "GET /creators/{creatorId}/milestones", "pathParameters": {}}, None)
    assert response["statusCode"] == 400


def test_store_failure_is_a_503_without_leaking_details(monkeypatch):
    """A DynamoDB failure is a 503 MILESTONES_UNAVAILABLE and the AWS error text stays in the logs."""

    def _boom(creator_id):
        raise store.CreatorMilestonesStoreError("Failed to read YobiCreatorMilestones: AccessDeniedException secret-detail")

    monkeypatch.setattr(store, "get_creator_milestones", _boom)
    response = _call("hoshimachi_suisei")
    assert response["statusCode"] == 503
    assert json.loads(response["body"])["code"] == "MILESTONES_UNAVAILABLE"
    assert "secret-detail" not in response["body"]


def test_every_dataset_creator_resolves_through_the_api():
    """All 110 seeded ids pass Creator Master validation and return their own record."""
    assert len(RECORDS) == 110
    for creator_id, row in RECORDS.items():
        assert read_api.get_creator_milestones({"creatorId": creator_id}) == {
            "creatorId": creator_id,
            "birthday": row["birthday"],
            "debutDate": row["debutDate"],
        }


def test_route_is_registered():
    """The handler route exists (tests/test_api_gateway_routes.py covers the Terraform side)."""
    assert "GET /creators/{creatorId}/milestones" in api_handler._ROUTES


# --- GET /milestones: the bulk read ---------------------------------------------------------------------------------------------------------


def _bulk() -> dict:
    return api_handler.lambda_handler({"routeKey": "GET /milestones"}, None)


@pytest.fixture
def bulk_store(monkeypatch):
    """Serve the 110-record production dataset from the bulk store function (no AWS call), counting how often it is asked."""
    calls = []

    def _all(now=None):
        calls.append(1)
        return [{"creatorId": cid, "birthday": row["birthday"], "debutDate": row["debutDate"]} for cid, row in sorted(RECORDS.items())]

    monkeypatch.setattr(store, "get_all_creator_milestones", _all)
    return calls


def test_bulk_returns_all_110_records_with_exactly_the_three_fields(bulk_store):
    """One response carries the whole roster, active and graduated, as {creatorId, birthday, debutDate}."""
    response = _bulk()
    assert response["statusCode"] == 200
    records = json.loads(response["body"])["milestones"]
    assert len(records) == 110
    assert all(set(record) == {"creatorId", "birthday", "debutDate"} for record in records)
    by_id = {record["creatorId"]: record for record in records}
    assert by_id["hoshimachi_suisei"] == {"creatorId": "hoshimachi_suisei", "birthday": "03-22", "debutDate": "2018-03-22"}
    assert by_id["mano_aloe"]["debutDate"] == "2020-08-15"


def test_bulk_is_one_store_read_not_one_per_creator(bulk_store):
    """The handler asks the store once for the whole roster."""
    _bulk()
    assert len(bulk_store) == 1


def test_bulk_response_is_browser_cacheable_for_an_hour(bulk_store):
    """A successful bulk response carries Cache-Control max-age 3600, so a browser that has it does not call the API again within the hour."""
    assert _bulk()["headers"]["Cache-Control"] == "public, max-age=3600"


def test_other_responses_are_not_marked_cacheable(bulk_store):
    """Only the bulk roster route is cacheable: the per-creator route and error responses carry no Cache-Control."""
    single = api_handler.lambda_handler({"routeKey": "GET /creators/{creatorId}/milestones", "pathParameters": {"creatorId": "hoshimachi_suisei"}}, None)
    assert "Cache-Control" not in single["headers"]
    assert "Cache-Control" not in api_handler.lambda_handler({"routeKey": "GET /nope"}, None)["headers"]


def test_bulk_store_failure_is_a_503_that_is_never_cached_and_leaks_nothing(monkeypatch):
    """A DynamoDB failure follows the existing 503 convention, without Cache-Control and without the AWS error text."""

    def _boom(now=None):
        raise store.CreatorMilestonesStoreError("Failed to scan YobiCreatorMilestones: AccessDeniedException secret-detail")

    monkeypatch.setattr(store, "get_all_creator_milestones", _boom)
    response = _bulk()
    assert response["statusCode"] == 503
    assert json.loads(response["body"])["code"] == "MILESTONES_UNAVAILABLE"
    assert "secret-detail" not in response["body"]
    assert "Cache-Control" not in response["headers"]


def test_bulk_route_is_registered_and_has_a_gateway_route():
    """The handler route exists; the gateway parity tests cover the Terraform side."""
    assert "GET /milestones" in api_handler._ROUTES


def test_manual_iam_policy_allows_only_get_and_scan_on_exactly_this_table():
    """The prepared (not applied) Lambda policy grants GetItem and Scan on the one table, nothing else."""
    policy_path = Path(__file__).parent.parent.parent / "terraform" / "manual-iam" / "policy-lambda-creator-milestones-read.json"
    statements = json.loads(policy_path.read_text(encoding="utf-8"))["Statement"]
    assert len(statements) == 1
    statement = statements[0]
    assert statement["Effect"] == "Allow"
    assert sorted(statement["Action"]) == ["dynamodb:GetItem", "dynamodb:Scan"]
    assert statement["Resource"] == "arn:aws:dynamodb:ap-northeast-1:189461315571:table/YobiCreatorMilestones"