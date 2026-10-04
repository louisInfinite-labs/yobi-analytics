"""Tests for api.read_api.get_subscriber_leaderboard (ranking-simplification,
R5) -- the read-only API over the R4 S3 subscriber-ranking result.
"""

from __future__ import annotations

from datetime import date

import pytest

from api import read_api
from tracking.creator_master import Creator


def _creator(**overrides) -> Creator:
    fields = {
        "creator_id": "aizawa_ema",
        "display_name": "藍沢エマ",
        "organization": "vspo",
        "youtube_channel_id": "UC_test",
        "active": True,
        "branch": "vspo_jp",
        "group_key": ["1期生"],
        "channel_type": "member",
        "lifecycle_stage": "active",
        "display_order": 0,
    }
    fields.update(overrides)
    return Creator(**fields)


def _total_row(rank: int, creator_id: str, organization: str, subscriber_count: int) -> dict:
    return {"rank": rank, "creatorId": creator_id, "organization": organization, "subscriberCount": subscriber_count}


def _growth_row(rank: int, creator_id: str, organization: str, absolute_growth: int, percentage_growth=None) -> dict:
    return {
        "rank": rank,
        "creatorId": creator_id,
        "organization": organization,
        "currentSubscriberCount": 1000 + absolute_growth,
        "anchorSubscriberCount": 1000,
        "absoluteGrowth": absolute_growth,
        "percentageGrowth": percentage_growth,
    }


def _payload(**overrides) -> dict:
    payload = {
        "schemaVersion": 1,
        "reportDate": "2026-09-29",
        "generatedAt": "2026-09-29T18:05:00+09:00",
        "expectedCreatorCount": 3,
        "observedCreatorCount": 3,
        "missingCreatorCount": 0,
        "total": {
            "rows": [
                _total_row(1, "holo_1", "hololive", 500),
                _total_row(2, "vspo_1", "vspo", 400),
                _total_row(3, "holo_2", "hololive", 300),
            ],
            "ineligible": {"creator_hidden": "current_hidden"},
        },
        "1d": {"rows": [_growth_row(1, "vspo_1", "vspo", 30), _growth_row(2, "holo_1", "hololive", 10)], "ineligible": {}},
        "7d": {"rows": [_growth_row(1, "holo_1", "hololive", 70)], "ineligible": {}},
        "30d": {"rows": [_growth_row(1, "holo_2", "hololive", 300)], "ineligible": {}},
    }
    payload.update(overrides)
    return payload


class _FakeRankingStore:
    def __init__(self, payload_by_date: dict[str, dict | None]):
        self._payload_by_date = payload_by_date

    def read_result(self, report_date: date):
        return self._payload_by_date.get(report_date.isoformat())


def _wire_store(monkeypatch, payload_by_date: dict[str, dict | None]):
    fake_store = _FakeRankingStore(payload_by_date)

    class _FakeStoreClass:
        @classmethod
        def from_environment_or_default(cls, *, s3_client=None):
            return fake_store

    monkeypatch.setattr(read_api, "S3SubscriberRankingStore", _FakeStoreClass)


DEFAULT_CREATORS = [
    _creator(creator_id="holo_1", organization="hololive"),
    _creator(creator_id="holo_2", organization="hololive"),
    _creator(creator_id="vspo_1", organization="vspo"),
    _creator(creator_id="creator_hidden", organization="hololive"),
]


def _query(**overrides) -> dict:
    query = {"metric": "total", "reportDate": "2026-09-29"}
    query.update(overrides)
    return query


# --- 1. reads one R4 S3 result ------------------------------------------------


def test_reads_one_r4_s3_result(monkeypatch):
    _wire_store(monkeypatch, {"2026-09-29": _payload()})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    result = read_api.get_subscriber_leaderboard(_query())

    assert result["reportDate"] == "2026-09-29"
    assert result["generatedAt"] == "2026-09-29T18:05:00+09:00"


# --- 2/3/4/5. metric mapping --------------------------------------------------


def test_metric_total_returns_the_total_section(monkeypatch):
    _wire_store(monkeypatch, {"2026-09-29": _payload()})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    result = read_api.get_subscriber_leaderboard(_query(metric="total"))

    assert result["metric"] == "total"
    assert [row["creatorId"] for row in result["rows"]] == ["holo_1", "vspo_1", "holo_2"]
    assert "1d" not in result and "7d" not in result and "30d" not in result and "total" not in result


@pytest.mark.parametrize("metric,expected_creator_order", [("1d", ["vspo_1", "holo_1"]), ("7d", ["holo_1"]), ("30d", ["holo_2"])])
def test_growth_metrics_return_their_own_section_only(monkeypatch, metric, expected_creator_order):
    _wire_store(monkeypatch, {"2026-09-29": _payload()})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    result = read_api.get_subscriber_leaderboard(_query(metric=metric))

    assert result["metric"] == metric
    assert [row["creatorId"] for row in result["rows"]] == expected_creator_order


# --- 6/7/8. organization filter -----------------------------------------------


def test_all_returns_the_full_canonical_ordering(monkeypatch):
    _wire_store(monkeypatch, {"2026-09-29": _payload()})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    result = read_api.get_subscriber_leaderboard(_query(organization="all"))

    assert [row["creatorId"] for row in result["rows"]] == ["holo_1", "vspo_1", "holo_2"]
    assert [row["rank"] for row in result["rows"]] == [1, 2, 3]


def test_vspo_filters_correctly(monkeypatch):
    _wire_store(monkeypatch, {"2026-09-29": _payload()})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    result = read_api.get_subscriber_leaderboard(_query(organization="vspo"))

    assert [row["creatorId"] for row in result["rows"]] == ["vspo_1"]
    assert result["organization"] == "vspo"


def test_hololive_filters_correctly(monkeypatch):
    _wire_store(monkeypatch, {"2026-09-29": _payload()})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    result = read_api.get_subscriber_leaderboard(_query(organization="hololive"))

    assert [row["creatorId"] for row in result["rows"]] == ["holo_1", "holo_2"]


# --- 9/10. rank re-numbering, no re-sort --------------------------------------


def test_filtered_ranks_are_renumbered_from_one(monkeypatch):
    _wire_store(monkeypatch, {"2026-09-29": _payload()})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    result = read_api.get_subscriber_leaderboard(_query(organization="hololive"))

    assert [row["rank"] for row in result["rows"]] == [1, 2]


def test_filtering_does_not_re_sort_by_subscriber_count_within_the_filtered_subset(monkeypatch):
    """holo_1 (500) ranks ahead of holo_2 (300) in the canonical list --
    filtering to hololive must preserve that relative order, not re-sort."""
    _wire_store(monkeypatch, {"2026-09-29": _payload()})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    result = read_api.get_subscriber_leaderboard(_query(organization="hololive"))

    assert [row["subscriberCount"] for row in result["rows"]] == [500, 300]


# --- 11. percentage does not determine ranking order -------------------------


def test_percentage_growth_field_is_passed_through_unmodified_and_unused_for_ordering(monkeypatch):
    payload = _payload()
    payload["1d"]["rows"] = [
        _growth_row(1, "vspo_1", "vspo", 30, percentage_growth=0.03),
        _growth_row(2, "holo_1", "hololive", 10, percentage_growth=5.0),
    ]
    _wire_store(monkeypatch, {"2026-09-29": payload})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    result = read_api.get_subscriber_leaderboard(_query(metric="1d"))

    # holo_1 has a far higher percentage but stays rank 2 -- order untouched.
    assert [row["creatorId"] for row in result["rows"]] == ["vspo_1", "holo_1"]
    assert result["rows"][1]["percentageGrowth"] == 5.0


# --- 12. completeness metadata preserved --------------------------------------


def test_completeness_metadata_preserved_and_unfiltered_by_organization(monkeypatch):
    _wire_store(monkeypatch, {"2026-09-29": _payload(expectedCreatorCount=4, observedCreatorCount=3, missingCreatorCount=1)})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    result = read_api.get_subscriber_leaderboard(_query(organization="vspo"))

    assert result["expectedCreatorCount"] == 4
    assert result["observedCreatorCount"] == 3
    assert result["missingCreatorCount"] == 1


# --- 13. diagnostics filtered consistently ------------------------------------


def test_ineligible_diagnostics_filtered_by_authoritative_organization(monkeypatch):
    payload = _payload()
    payload["total"]["ineligible"] = {"creator_hidden": "current_hidden"}
    _wire_store(monkeypatch, {"2026-09-29": payload})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)  # creator_hidden is hololive

    all_result = read_api.get_subscriber_leaderboard(_query(organization="all"))
    holo_result = read_api.get_subscriber_leaderboard(_query(organization="hololive"))
    vspo_result = read_api.get_subscriber_leaderboard(_query(organization="vspo"))

    assert all_result["ineligible"] == {"creator_hidden": "current_hidden"}
    assert holo_result["ineligible"] == {"creator_hidden": "current_hidden"}
    assert vspo_result["ineligible"] == {}  # must not leak a hololive creator into the vspo view


def test_ineligible_diagnostics_never_guess_organization_for_an_unknown_creator(monkeypatch):
    """creator_ghost is not in Creator Master at all (e.g. R2's own
    creator_not_in_roster case) -- it must never be attributed to any
    specific organization filter, only visible under organization=all."""
    payload = _payload()
    payload["total"]["ineligible"] = {"creator_ghost": "creator_not_in_roster"}
    _wire_store(monkeypatch, {"2026-09-29": payload})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    all_result = read_api.get_subscriber_leaderboard(_query(organization="all"))
    holo_result = read_api.get_subscriber_leaderboard(_query(organization="hololive"))
    vspo_result = read_api.get_subscriber_leaderboard(_query(organization="vspo"))

    assert all_result["ineligible"] == {"creator_ghost": "creator_not_in_roster"}
    assert holo_result["ineligible"] == {}
    assert vspo_result["ineligible"] == {}


# --- 14. missing result object -> not-found/unavailable convention ----------


def test_missing_result_object_raises_ranking_not_ready(monkeypatch):
    _wire_store(monkeypatch, {})  # nothing persisted for any date
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    with pytest.raises(read_api.RankingNotReadyError):
        read_api.get_subscriber_leaderboard(_query(reportDate="2026-09-29"))


# --- 15/16. invalid organization/metric -> 400 --------------------------------


def test_invalid_organization_raises_client_error(monkeypatch):
    _wire_store(monkeypatch, {"2026-09-29": _payload()})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    with pytest.raises(read_api.ClientError):
        read_api.get_subscriber_leaderboard(_query(organization="apex_predators"))


def test_invalid_metric_raises_client_error(monkeypatch):
    _wire_store(monkeypatch, {"2026-09-29": _payload()})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    with pytest.raises(read_api.ClientError):
        read_api.get_subscriber_leaderboard(_query(metric="percentage"))


def test_missing_metric_raises_client_error(monkeypatch):
    _wire_store(monkeypatch, {"2026-09-29": _payload()})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    with pytest.raises(read_api.ClientError):
        read_api.get_subscriber_leaderboard({"reportDate": "2026-09-29"})


def test_organization_is_never_silently_coerced():
    with pytest.raises(read_api.ClientError):
        read_api.parse_subscriber_organization("VSPO_TYPO")


# --- 17/18. exact date -> deterministic S3 key, no nearest-date fallback ----


def test_requested_historical_date_maps_to_the_exact_deterministic_key(monkeypatch):
    other_day_payload = _payload(reportDate="2026-09-28")
    _wire_store(monkeypatch, {"2026-09-28": other_day_payload})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    result = read_api.get_subscriber_leaderboard(_query(reportDate="2026-09-28"))

    assert result["reportDate"] == "2026-09-28"


def test_no_nearest_date_fallback_when_the_exact_date_is_missing(monkeypatch):
    # A result exists for a nearby date, but the exact requested date does not.
    _wire_store(monkeypatch, {"2026-09-28": _payload(reportDate="2026-09-28")})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    with pytest.raises(read_api.RankingNotReadyError):
        read_api.get_subscriber_leaderboard(_query(reportDate="2026-09-29"))


def test_omitted_report_date_defaults_to_today_in_canonical_time_zone(monkeypatch):
    monkeypatch.setattr(read_api, "_today_in_canonical_time_zone", lambda: date(2026, 9, 29))
    _wire_store(monkeypatch, {"2026-09-29": _payload()})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    result = read_api.get_subscriber_leaderboard({"metric": "total"})

    assert result["reportDate"] == "2026-09-29"


# --- R5 correction: omitted reportDate means "latest available result", ----
# --- not strictly today -- production has a real pre-collection window ----
# --- (the daily_history execution only runs at 18:00 JST) -----------------


def test_omitted_report_date_falls_back_to_the_latest_available_result_when_today_is_not_yet_computed(monkeypatch):
    """14:00 JST example from the correction: today's object doesn't exist
    yet, but yesterday's complete result does -- the default request must
    return yesterday's result, not RankingNotReadyError."""
    monkeypatch.setattr(read_api, "_today_in_canonical_time_zone", lambda: date(2026, 9, 29))
    _wire_store(monkeypatch, {"2026-09-28": _payload(reportDate="2026-09-28")})  # only yesterday exists
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    result = read_api.get_subscriber_leaderboard({"metric": "total"})

    assert result["reportDate"] == "2026-09-28"


def test_omitted_report_date_response_reflects_the_actual_selected_date_not_todays_default(monkeypatch):
    """The response's own reportDate must be the real persisted result's
    date, never silently reported as "today" just because that was the
    default that was requested."""
    monkeypatch.setattr(read_api, "_today_in_canonical_time_zone", lambda: date(2026, 9, 29))
    _wire_store(monkeypatch, {"2026-09-27": _payload(reportDate="2026-09-27")})  # within the 3-day lookback
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    result = read_api.get_subscriber_leaderboard({"metric": "total"})

    assert result["reportDate"] == "2026-09-27"
    assert result["reportDate"] != "2026-09-29"


def test_omitted_report_date_still_raises_ranking_not_ready_outside_the_lookback_window(monkeypatch):
    """The fallback is bounded (LATEST_REPORT_LOOKBACK_DAYS), the same as
    every other cache-only leaderboard here -- it is "latest available
    within a few days", not an unbounded search back through all history."""
    monkeypatch.setattr(read_api, "_today_in_canonical_time_zone", lambda: date(2026, 9, 29))
    _wire_store(monkeypatch, {})  # nothing persisted for today or the lookback window
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    with pytest.raises(read_api.RankingNotReadyError):
        read_api.get_subscriber_leaderboard({"metric": "total"})


def test_explicit_report_date_never_falls_back_even_when_a_newer_result_exists(monkeypatch):
    """An explicit reportDate is an exact lookup only -- unlike the omitted
    case, it must not silently prefer a newer/other available result."""
    monkeypatch.setattr(read_api, "_today_in_canonical_time_zone", lambda: date(2026, 9, 29))
    _wire_store(monkeypatch, {"2026-09-29": _payload()})  # today exists, but a different date is requested
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    with pytest.raises(read_api.RankingNotReadyError):
        read_api.get_subscriber_leaderboard(_query(reportDate="2026-09-28"))


# --- R5 correction: API Lambda S3 IAM proof (no policy change needed) -------


def test_api_lambda_shares_the_role_already_granted_s3_get_object_on_the_history_bucket():
    """aws_lambda_function.api (the Lambda this new route runs on) is not
    given its own role -- lambda.tf assigns it the exact same
    local.lambda_role_arn as history_worker/collector/ranking_reducer, and
    terraform/manual-iam/policy-lambda-history-access.json (the inline
    policy manually attached to that one shared yobi-analytics-lambda-role
    -- see terraform/history.tf's own comment identifying it as such)
    already grants s3:GetObject on a bucket-wide arn:aws:s3:::yobi-
    analytics-history/* wildcard, which already covers
    subscriber-ranking/date=YYYY-MM-DD.json with no policy change needed."""
    import json
    import pathlib

    repo_root = pathlib.Path(__file__).resolve().parent.parent.parent
    lambda_tf = (repo_root / "terraform" / "lambda.tf").read_text()
    policy = json.loads((repo_root / "terraform" / "manual-iam" / "policy-lambda-history-access.json").read_text())

    api_block_start = lambda_tf.index('resource "aws_lambda_function" "api"')
    next_resource = lambda_tf.find('\nresource "aws_lambda_function"', api_block_start + 1)
    api_block = lambda_tf[api_block_start : next_resource if next_resource != -1 else len(lambda_tf)]
    assert "role          = local.lambda_role_arn" in api_block

    matching_statements = [
        statement
        for statement in policy["Statement"]
        for resource in ([statement["Resource"]] if isinstance(statement["Resource"], str) else statement["Resource"])
        if "yobi-analytics-history" in resource and resource.endswith("/*")
    ]
    assert matching_statements, "expected a Statement granting access on arn:...:yobi-analytics-history/*"
    assert any("s3:GetObject" in statement["Action"] for statement in matching_statements)


# --- 19/20. no DynamoDB/TrendingCache access, no S3 write --------------------


def test_no_s3_write_from_the_read_path(monkeypatch):
    write_calls = []

    class _FakeStoreClass:
        @classmethod
        def from_environment_or_default(cls, *, s3_client=None):
            store = _FakeRankingStore({"2026-09-29": _payload()})
            store.write_result = lambda *a, **k: write_calls.append(1)
            return store

    monkeypatch.setattr(read_api, "S3SubscriberRankingStore", _FakeStoreClass)
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    read_api.get_subscriber_leaderboard(_query())

    assert write_calls == []


# --- 21. no new Lambda/scheduler/state-machine (Terraform-level check) ------


def test_new_route_uses_the_existing_api_lambda_integration_only():
    import re

    api_gateway_tf = open("terraform/api_gateway.tf").read()
    lambda_tf = open("terraform/lambda.tf").read()

    assert '"GET /subscribers/leaderboard"' in api_gateway_tf
    # Exactly one integration/one Lambda backs every route in api_routes,
    # including the new one -- no second aws_apigatewayv2_integration block.
    assert len(re.findall(r'resource\s+"aws_apigatewayv2_integration"', api_gateway_tf)) == 1
    functions = set(re.findall(r'resource\s+"aws_lambda_function"\s+"(\w+)"', lambda_tf))
    assert functions == {"collector", "history_worker", "ranking_reducer", "api", "notification_dispatcher", "emergency_stop"}


# --- routing wiring (api_handler.py) -----------------------------------------


def test_route_is_registered_in_api_handler():
    from api import api_handler

    assert "GET /subscribers/leaderboard" in api_handler._ROUTES


def test_api_handler_maps_ranking_not_ready_to_503(monkeypatch):
    from api import api_handler

    _wire_store(monkeypatch, {})  # nothing persisted for any date
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    event = {
        "routeKey": "GET /subscribers/leaderboard",
        "queryStringParameters": {"metric": "total", "reportDate": "2026-09-29"},
    }
    response = api_handler.lambda_handler(event, None)

    assert response["statusCode"] == 503
    import json

    assert json.loads(response["body"])["code"] == "RANKING_NOT_READY"


def test_api_handler_maps_invalid_metric_to_400(monkeypatch):
    from api import api_handler

    _wire_store(monkeypatch, {"2026-09-29": _payload()})
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    event = {
        "routeKey": "GET /subscribers/leaderboard",
        "queryStringParameters": {"metric": "bogus", "reportDate": "2026-09-29"},
    }
    response = api_handler.lambda_handler(event, None)

    assert response["statusCode"] == 400
