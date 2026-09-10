"""End-to-end test of ranking_reducer.lambda_handler's own read/merge loop —
confirms it reads each shard exactly once (via read_bundle, never a separate
read()+read_creator_partials() pair) and still produces the same cache-write
output the previous read()+merge_partial_rankings() approach would have.
"""

import io
import json
from datetime import date

import dynamodb_store
import execution_lock
import pytest
import ranking_reducer
from botocore.exceptions import ClientError
from creator_master import Creator
from history_ranking import CreatorPeriodPartial, RankedGrowth
from history_store import HISTORY_SHARD_COUNT
from ranking_partial_store import S3PartialRankingStore


def _instant_budget():
    """A WruBudget whose target is so high that charge() never actually
    sleeps -- for tests that exercise persist_* directly but aren't
    themselves about pacing behavior."""
    return ranking_reducer.WruBudget(target_wru_per_second=1_000_000)


def _creator(creator_id, organization="vspo"):
    return Creator(
        creator_id=creator_id,
        display_name=creator_id,
        organization=organization,
        youtube_channel_id="UC_test",
        active=True,
        branch="vspo_jp",
        group_key=["1期生"],
        channel_type="member",
        lifecycle_stage="active",
    )


class _CountingS3Client:
    """Backs a real S3PartialRankingStore, tracking how many GetObject calls
    ranking_reducer.lambda_handler's own read loop actually makes."""

    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.get_calls = 0

    def put_object(self, *, Bucket, Key, Body, ContentType):
        self.objects[Key] = Body

    def get_object(self, *, Bucket, Key):
        self.get_calls += 1
        if Key not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "boom"}}, "GetObject")
        return {"Body": io.BytesIO(self.objects[Key])}


def _ranked(video_id, creator_id, *, value, rank, period="7d"):
    return RankedGrowth(
        rank=rank,
        video_id=video_id,
        creator_id=creator_id,
        period=period,
        view_count=value,
        anchor_view_count=0,
        gain=value,
        observed_at="2026-09-09T18:00:00+09:00",
    )


def test_lambda_handler_reads_every_shard_exactly_once_via_read_bundle(monkeypatch):
    report_date = date(2026, 9, 9)
    client = _CountingS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)

    # Shard 3 holds the single highest-value video; every other shard is empty
    # (a legitimate, common case -- most shards have no Top-N-worthy entries
    # for a given scope/period), proving the merge still finds the true winner
    # regardless of which shard it came from.
    for shard in range(HISTORY_SHARD_COUNT):
        if shard == 3:
            rankings = {("creator", "c1"): {"7d": [_ranked("winner", "c1", value=999_999, rank=1)]}}
            creator_partials = {
                "c1": {"7d": CreatorPeriodPartial(
                    creator_id="c1", period="7d", view_sum=999_999,
                    catalog_video_count=1, eligible_video_count=1,
                    top_candidates=[_ranked("winner", "c1", value=999_999, rank=1)],
                )}
            }
        else:
            rankings, creator_partials = {}, {}
        store.write(report_date, shard, rankings, creator_partials)

    client.get_calls = 0  # ignore the writes above; only count the reducer's own reads

    monkeypatch.setattr(ranking_reducer, "S3PartialRankingStore", lambda bucket_name: store)
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", "test-bucket")
    monkeypatch.setattr(dynamodb_store, "get_video", lambda video_id: None)
    monkeypatch.setattr(ranking_reducer, "load_creators", lambda: [_creator("c1", organization="vspo")])
    monkeypatch.setattr(execution_lock, "renew_execution_lock", lambda **kwargs: None)
    cache_writes = []
    monkeypatch.setattr(
        dynamodb_store, "put_cached_trending", lambda key, payload, *, computed_at: cache_writes.append((key, payload))
    )

    result = ranking_reducer.lambda_handler({"reportDate": report_date.isoformat(), "ownerToken": "exec-1"}, None)

    assert client.get_calls == HISTORY_SHARD_COUNT == 16
    # 1 scope-ranking write + 1 creator-summary write (c1/7d) + 1
    # organization-leaderboard write (vspo/7d, c1's only org, single member).
    assert result == {
        "date": "2026-09-09",
        "reportDate": "2026-09-09",
        "ownerToken": "exec-1",
        "cacheWrites": 3,
    }
    writes_by_key = dict(cache_writes)
    keys_written = list(writes_by_key)
    (scope_key,) = [key for key in keys_written if key.startswith("creator:c1:")]
    assert [row["videoId"] for row in writes_by_key[scope_key]["results"]] == ["winner"]
    assert any(key.startswith("creatorSummary:c1:7d:") for key in keys_written)
    assert any(key.startswith("orgLeaderboard:vspo:7d:") for key in keys_written)


# --- persist_creator_and_organization_rankings (unit-level) -----------------


def _creator_partial(creator_id, period, *, view_sum, catalog, eligible, top_candidates):
    return CreatorPeriodPartial(
        creator_id=creator_id,
        period=period,
        view_sum=view_sum,
        catalog_video_count=catalog,
        eligible_video_count=eligible,
        top_candidates=top_candidates,
    )


def test_persist_creator_and_organization_rankings_writes_all_four_periods_per_creator():
    """One item per (creatorId, period) -- never all four periods folded into
    a single item (that would quadruple an API read for just one period)."""
    report_date = date(2026, 9, 9)
    creator_partials = {
        "c1": {
            period: _creator_partial(
                "c1", period, view_sum=100, catalog=1, eligible=1,
                top_candidates=[_ranked("v1", "c1", value=100, rank=1, period=period)],
            )
            for period in ("1d", "7d", "30d", "all")
        }
    }
    writes_log = []
    ranking_reducer.persist_creator_and_organization_rankings(
        creator_partials,
        report_date=report_date,
        dimensions_by_creator={},
        put_cached_trending=lambda key, payload, *, computed_at: writes_log.append((key, payload)),
        computed_at="2026-09-09T18:05:00+09:00",
        wru_budget=_instant_budget(),
    )

    assert len(writes_log) == 4
    periods_written = {payload["period"] for _, payload in writes_log}
    assert periods_written == {"1d", "7d", "30d", "all"}
    for key, payload in writes_log:
        assert key == f"creatorSummary:c1:{payload['period']}:2026-09-09"


def test_persist_creator_and_organization_rankings_creator_summary_fields_are_complete():
    report_date = date(2026, 9, 9)
    creator_partials = {
        "c1": {
            "7d": _creator_partial(
                "c1", "7d", view_sum=1_500, catalog=10, eligible=8,
                top_candidates=[
                    _ranked("best", "c1", value=900, rank=1, period="7d"),
                    _ranked("second", "c1", value=600, rank=2, period="7d"),
                ],
            )
        }
    }
    writes_log = []
    ranking_reducer.persist_creator_and_organization_rankings(
        creator_partials,
        report_date=report_date,
        dimensions_by_creator={},
        put_cached_trending=lambda key, payload, *, computed_at: writes_log.append((key, payload)),
        computed_at="2026-09-09T18:05:00+09:00",
        wru_budget=_instant_budget(),
    )

    ((_, payload),) = writes_log
    assert payload == {
        "creatorId": "c1",
        "period": "7d",
        "reportDate": "2026-09-09",
        "viewSum": 1_500,
        "catalogVideoCount": 10,
        "eligibleVideoCount": 8,
        "isComplete": False,  # 8 != 10
        "topVideo": {
            "rank": 1, "videoId": "best", "value": 900,
            "latestViewCount": 900, "lastUpdatedAt": "2026-09-09T18:00:00+09:00",
        },
        "top10": [
            {"rank": 1, "videoId": "best", "value": 900, "latestViewCount": 900, "lastUpdatedAt": "2026-09-09T18:00:00+09:00"},
            {"rank": 2, "videoId": "second", "value": 600, "latestViewCount": 600, "lastUpdatedAt": "2026-09-09T18:00:00+09:00"},
        ],
    }


def test_persist_creator_and_organization_rankings_writes_both_leaderboard_kinds_per_organization():
    report_date = date(2026, 9, 9)
    creator_partials = {
        "steady": {"7d": _creator_partial("steady", "7d", view_sum=900, catalog=9, eligible=9,
                                           top_candidates=[_ranked("s_v1", "steady", value=100, rank=1, period="7d")])},
        "viral": {"7d": _creator_partial("viral", "7d", view_sum=800, catalog=1, eligible=1,
                                          top_candidates=[_ranked("v_v1", "viral", value=800, rank=1, period="7d")])},
    }
    dimensions_by_creator = {
        "steady": ranking_reducer.CreatorDimensions(organization="vspo", branch="vspo_jp"),
        "viral": ranking_reducer.CreatorDimensions(organization="vspo", branch="vspo_jp"),
    }
    writes_log = []
    ranking_reducer.persist_creator_and_organization_rankings(
        creator_partials,
        report_date=report_date,
        dimensions_by_creator=dimensions_by_creator,
        put_cached_trending=lambda key, payload, *, computed_at: writes_log.append((key, payload)),
        computed_at="2026-09-09T18:05:00+09:00",
        wru_budget=_instant_budget(),
    )

    org_writes = {key: payload for key, payload in writes_log if key.startswith("orgLeaderboard:")}
    assert len(org_writes) == 1  # one org, one period -> one item, not one per leaderboard kind
    ((_, payload),) = org_writes.items()
    assert payload["organization"] == "vspo"
    assert payload["period"] == "7d"
    assert payload["reportDate"] == "2026-09-09"
    assert [e["creatorId"] for e in payload["byTotalViews"]] == ["steady", "viral"]
    assert [e["creatorId"] for e in payload["byTopVideo"]] == ["viral", "steady"]
    assert payload["byTopVideo"][0]["videoId"] == "v_v1"


def test_new_cache_namespace_never_collides_with_existing_scope_ranking_keys():
    """creatorSummary:*/orgLeaderboard:* keys must never equal any key
    trending_cache_key (the existing scope-ranking scheme) can produce for
    the same creatorId/organization/period/reportDate -- YobiTrendingCache
    has only a single partition key (cacheKey, no sort key), so this is the
    entire uniqueness guarantee."""
    from read_api import trending_cache_key

    report_date = date(2026, 9, 9)
    new_creator_key = ranking_reducer.creator_summary_cache_key(creator_id="c1", period="7d", report_date=report_date)
    new_org_key = ranking_reducer.organization_leaderboard_cache_key(
        organization="vspo", period="7d", report_date=report_date
    )
    existing_keys = {
        trending_cache_key(
            scope_type=scope_type, scope_value=value, period="7d", ranking_type="7d_trending", report_date=report_date
        )
        for scope_type, value in [("creator", "c1"), ("organization", "vspo"), ("branch", "vspo_jp"), ("global", "global")]
    }

    assert new_creator_key not in existing_keys
    assert new_org_key not in existing_keys
    assert new_creator_key != new_org_key


def test_lambda_handler_calls_load_creators_exactly_once(monkeypatch):
    """Organization membership AND scope-ranking enrichment must both reuse
    the same single batch load_creators() call (a bundled local JSON file,
    not DynamoDB) -- never a per-creator lookup, and never loaded twice for
    two different purposes in one invocation. Scaling to 50 creators here
    must not scale the call count."""
    report_date = date(2026, 9, 9)
    client = _CountingS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)
    for shard in range(HISTORY_SHARD_COUNT):
        store.write(report_date, shard, {}, {})

    monkeypatch.setattr(ranking_reducer, "S3PartialRankingStore", lambda bucket_name: store)
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", "test-bucket")
    monkeypatch.setattr(dynamodb_store, "get_video", lambda video_id: None)
    monkeypatch.setattr(dynamodb_store, "put_cached_trending", lambda key, payload, *, computed_at: None)
    monkeypatch.setattr(execution_lock, "renew_execution_lock", lambda **kwargs: None)
    load_creators_calls = []

    def _counting_load_creators():
        load_creators_calls.append(1)
        return [_creator(f"c{i}") for i in range(50)]

    monkeypatch.setattr(ranking_reducer, "load_creators", _counting_load_creators)

    ranking_reducer.lambda_handler({"reportDate": report_date.isoformat(), "ownerToken": "exec-1"}, None)

    # Exactly once total per invocation -- never 50 (once per creator), never
    # 2 (once per call site), and never growing with creator count.
    assert len(load_creators_calls) == 1


# --- WruBudget pacing (shared across persist_rankings and persist_creator_and_organization_rankings) --


def _fake_clock_and_sleeper():
    """A fake clock/sleeper pair where sleeping *advances* the fake clock by
    the requested duration, without ever really waiting -- so a test can
    assert on exactly how long WruBudget *would* have paced for, in zero
    real wall-clock time."""
    fake_time = [0.0]
    slept = []

    def clock():
        return fake_time[0]

    def sleeper(seconds):
        slept.append(seconds)
        fake_time[0] += seconds

    return clock, sleeper, slept


def test_wru_budget_charges_dynamodbs_own_ceil_bytes_over_1024_rule():
    budget = ranking_reducer.WruBudget(target_wru_per_second=1_000_000)
    assert budget.charge(1) == 1
    assert budget.charge(1024) == 1
    assert budget.charge(1025) == 2
    assert budget.charge(2048) == 2


def test_wru_budget_sleeps_to_keep_the_cumulative_rate_at_or_under_target():
    clock, sleeper, slept = _fake_clock_and_sleeper()
    budget = ranking_reducer.WruBudget(target_wru_per_second=10, clock=clock, sleeper=sleeper)

    budget.charge(10 * 1024)  # 10 WRU issued "instantly" -> must pace out to 1.0s
    budget.charge(10 * 1024)  # another 10 WRU -> paces out to a further 1.0s

    assert slept == [1.0, 1.0]
    assert budget.total_wru == 20


def test_wru_budget_never_sleeps_when_real_elapsed_time_already_keeps_pace():
    """If wall-clock time already advanced enough on its own (e.g. the actual
    network write took a while), charge() must not sleep on top of that --
    pacing is a floor, not a fixed per-item delay."""
    fake_time = [0.0]
    slept = []

    def clock():
        return fake_time[0]

    def sleeper(seconds):
        slept.append(seconds)

    budget = ranking_reducer.WruBudget(target_wru_per_second=10, clock=clock, sleeper=sleeper)
    fake_time[0] = 5.0  # 5 real seconds already passed since construction
    budget.charge(10 * 1024)  # 10 WRU -> ideal_elapsed=1.0s, already exceeded

    assert slept == []


def test_wru_budget_estimates_about_185_seconds_for_14816_wru_at_the_shared_target():
    """The exact 14,816 WRU figure measured for a full reducer run (336 scope +
    464 creator/org items). At TARGET_WRU_PER_SECOND=80, pacing this many WRU
    must take ~185 seconds -- and that alone must still land comfortably
    under the ranking_reducer Lambda's own 900s timeout (terraform/lambda.tf),
    leaving room for the S3 read/merge and Creator Master load steps too."""
    clock, sleeper, slept = _fake_clock_and_sleeper()
    budget = ranking_reducer.WruBudget(
        target_wru_per_second=ranking_reducer.TARGET_WRU_PER_SECOND, clock=clock, sleeper=sleeper
    )

    total_wru_for_a_full_reducer_run = 14_816
    budget.charge(total_wru_for_a_full_reducer_run * 1024)

    total_paced_seconds = sum(slept)
    assert total_paced_seconds == pytest.approx(185.2, abs=0.1)
    LAMBDA_TIMEOUT_SECONDS = 900
    generously_estimated_other_steps_seconds = 60  # S3 reads/merge + Creator Master load + per-item network latency
    assert total_paced_seconds + generously_estimated_other_steps_seconds < LAMBDA_TIMEOUT_SECONDS


def test_wru_budget_is_shared_and_cumulative_across_both_persist_functions():
    """persist_rankings and persist_creator_and_organization_rankings must
    charge into the *same* running total when given the same WruBudget --
    proving a shared budget, not two independent ones that could each stay
    under target individually while blowing past it together."""
    clock, sleeper, slept = _fake_clock_and_sleeper()
    budget = ranking_reducer.WruBudget(target_wru_per_second=1_000_000, clock=clock, sleeper=sleeper)

    rankings = {("creator", "c1"): {"7d": [_ranked("v1", "c1", value=100, rank=1)]}}
    ranking_reducer.persist_rankings(
        rankings,
        report_date=date(2026, 9, 9),
        creators={},
        get_video=lambda video_id: None,
        put_cached_trending=lambda key, payload, *, computed_at: None,
        computed_at="2026-09-09T18:05:00+09:00",
        wru_budget=budget,
    )
    wru_after_scope_writes = budget.total_wru
    assert wru_after_scope_writes > 0

    creator_partials = {
        "c1": {"7d": CreatorPeriodPartial(creator_id="c1", period="7d", view_sum=100, catalog_video_count=1, eligible_video_count=1, top_candidates=[])}
    }
    ranking_reducer.persist_creator_and_organization_rankings(
        creator_partials,
        report_date=date(2026, 9, 9),
        dimensions_by_creator={},
        put_cached_trending=lambda key, payload, *, computed_at: None,
        computed_at="2026-09-09T18:05:00+09:00",
        wru_budget=budget,
    )

    # The second call's writes must have been *added* to the first call's
    # running total, never a fresh/reset budget.
    assert budget.total_wru > wru_after_scope_writes


# --- _dynamodb_item_bytes: the real item size, not just payload's own JSON size --


def test_dynamodb_item_bytes_includes_cache_key_and_computed_at_not_just_payload():
    """dynamodb_store.put_cached_trending's actual Item is
    {"cacheKey": ..., "payload": json.dumps(payload), "computedAt": ...} --
    three String attributes. Measuring payload's own JSON size alone (an
    earlier version of this estimator) undercounts by every other
    attribute's name and value bytes."""
    cache_key = "creatorSummary:c1:7d:2026-09-09"
    payload = {"a": 1}
    computed_at = "2026-09-09T18:05:00+09:00"

    payload_only_bytes = len(json.dumps(payload).encode("utf-8"))
    full_item_bytes = ranking_reducer._dynamodb_item_bytes(cache_key=cache_key, payload=payload, computed_at=computed_at)

    assert full_item_bytes > payload_only_bytes
    expected = (
        len("cacheKey".encode("utf-8")) + len(cache_key.encode("utf-8"))
        + len("payload".encode("utf-8")) + len(json.dumps(payload).encode("utf-8"))
        + len("computedAt".encode("utf-8")) + len(computed_at.encode("utf-8"))
    )
    assert full_item_bytes == expected


def test_item_bytes_boundary_1024_charges_1_wru_and_1025_charges_2_wru():
    """Exactly 1024 bytes must charge 1 WRU; one byte more (1025) must charge
    2 -- ceil(bytes/1024), the real DynamoDB write-unit rounding rule,
    exercised through the actual item-size computation, not a hand-picked
    byte count handed straight to WruBudget.charge()."""

    def item_bytes(padding_len):
        payload = {"pad": "x" * padding_len}
        return ranking_reducer._dynamodb_item_bytes(cache_key="k", payload=payload, computed_at="c")

    base = item_bytes(0)
    padding_for_1024 = 1024 - base
    assert padding_for_1024 >= 0, "fixture base size already exceeds 1024 bytes; shrink cache_key/computed_at"

    bytes_at_1024 = item_bytes(padding_for_1024)
    bytes_at_1025 = item_bytes(padding_for_1024 + 1)
    assert bytes_at_1024 == 1024
    assert bytes_at_1025 == 1025

    budget = ranking_reducer.WruBudget(target_wru_per_second=1_000_000)
    assert budget.charge(bytes_at_1024) == 1
    assert budget.charge(bytes_at_1025) == 2


def test_item_bytes_counts_unicode_in_cache_key_as_utf8_bytes_not_python_code_points():
    """A non-ASCII cache_key (unlike `payload`, cache_key is never run through
    json.dumps' own ensure_ascii escaping) must be measured by its real
    UTF-8 byte length -- each of these Japanese characters is 3 bytes in
    UTF-8 but only 1 Python code point, so naive len() would undercount."""
    unicode_key = "creatorSummary:藍沢エマ:7d:2026-09-09"
    payload = {}
    computed_at = ""

    computed = ranking_reducer._dynamodb_item_bytes(cache_key=unicode_key, payload=payload, computed_at=computed_at)

    utf8_byte_sum = (
        len("cacheKey".encode("utf-8")) + len(unicode_key.encode("utf-8"))
        + len("payload".encode("utf-8")) + len(json.dumps(payload).encode("utf-8"))
        + len("computedAt".encode("utf-8")) + len(computed_at.encode("utf-8"))
    )
    naive_code_point_sum = (
        len("cacheKey") + len(unicode_key) + len("payload") + len(json.dumps(payload)) + len("computedAt") + len(computed_at)
    )

    assert computed == utf8_byte_sum
    assert computed > naive_code_point_sum  # proves the multi-byte characters were actually counted as multiple bytes
