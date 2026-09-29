"""End-to-end test of ranking_reducer.lambda_handler's own read/merge loop —
confirms it reads each shard exactly once (via read) and still produces the
same cache-write output the previous read()+merge_partial_rankings() approach
would have.
"""

import io
import json
from datetime import date

from stores import dynamodb_store
from collection import execution_lock
import pytest
from analytics import ranking_reducer
from botocore.exceptions import ClientError
from tracking.creator_master import Creator
from analytics.history_ranking import RankedGrowth
from stores.history_store import HISTORY_SHARD_COUNT
from stores.ranking_partial_store import S3PartialRankingStore, partial_ranking_key


def _instant_budget():
    """A WruBudget whose target is so high that charge() never actually
    sleeps -- for tests that exercise persist_* directly but aren't
    themselves about pacing behavior."""
    return ranking_reducer.WruBudget(target_wru_per_second=1_000_000)


class _NoArchiveStore:
    """A stand-in for S3TrendingCacheArchiveStore that disables archiving
    entirely (from_environment() -> None) -- for lambda_handler tests whose
    own purpose has nothing to do with the AWS Cost Recovery third-pass S3
    archive, so they don't need a real/fake S3 client just to avoid a real
    boto3 network call."""

    @staticmethod
    def from_environment(*, s3_client=None):
        return None


class _RecordingArchiveStore:
    """A stand-in for S3TrendingCacheArchiveStore that records every put()
    call in-memory, for tests that specifically assert on the AWS Cost
    Recovery third-pass S3 archive-mirroring behavior."""

    def __init__(self):
        self.puts: list[tuple[str, dict, str]] = []

    def put(self, cache_key, payload, *, computed_at):
        self.puts.append((cache_key, payload, computed_at))
        return f"trending-cache-archive/{cache_key}.json"

    def from_environment(self, *, s3_client=None):
        return self


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
        display_order=0,
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


def test_lambda_handler_reads_every_shard_exactly_once(monkeypatch):
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
        else:
            rankings = {}
        store.write(report_date, shard, rankings)

    client.get_calls = 0  # ignore the writes above; only count the reducer's own reads

    monkeypatch.setattr(ranking_reducer, "S3PartialRankingStore", lambda bucket_name: store)
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", "test-bucket")
    monkeypatch.setattr(dynamodb_store, "get_video", lambda video_id: None)
    monkeypatch.setattr(ranking_reducer, "load_creators", lambda: [_creator("c1", organization="vspo")])
    monkeypatch.setattr(execution_lock, "renew_execution_lock", lambda **kwargs: None)
    monkeypatch.setattr(ranking_reducer, "S3TrendingCacheArchiveStore", _NoArchiveStore)
    cache_writes = []
    monkeypatch.setattr(
        dynamodb_store, "put_cached_trending", lambda key, payload, *, computed_at: cache_writes.append((key, payload))
    )

    result = ranking_reducer.lambda_handler({"reportDate": report_date.isoformat(), "ownerToken": "exec-1"}, None)

    assert client.get_calls == HISTORY_SHARD_COUNT == 16
    # 1 scope-ranking write. R7 (AWS Cost Recovery) removed the organization-
    # leaderboard write this used to also produce; R8B (AWS Cost Recovery)
    # removed the creator-summary write for the same reason -- zero consumer.
    assert result == {
        "date": "2026-09-09",
        "reportDate": "2026-09-09",
        "ownerToken": "exec-1",
        "cacheWrites": 1,
    }
    writes_by_key = dict(cache_writes)
    keys_written = list(writes_by_key)
    (scope_key,) = [key for key in keys_written if key.startswith("creator:c1:")]
    assert [row["videoId"] for row in writes_by_key[scope_key]["results"]] == ["winner"]
    assert not any(key.startswith("creatorSummary:") for key in keys_written)


def test_persist_rankings_archives_every_write_when_archive_put_is_given():
    """AWS Cost Recovery (third pass, Scope F): every cache write must also be
    durably mirrored via archive_put when one is supplied -- proving the
    wiring, not just that _paced_put's own signature accepts it."""
    rankings = {("creator", "c1"): {"1d": [_ranked("v1", "c1", value=100, rank=1)]}}
    archived = []

    writes = ranking_reducer.persist_rankings(
        rankings,
        report_date=date(2026, 9, 9),
        creators={},
        get_video=lambda video_id: None,
        put_cached_trending=lambda key, payload, *, computed_at: None,
        computed_at="2026-09-09T18:05:00+09:00",
        wru_budget=_instant_budget(),
        archive_put=lambda key, payload, *, computed_at: archived.append((key, payload, computed_at)),
    )

    assert writes == 1
    assert len(archived) == 1
    key, payload, computed_at = archived[0]
    assert key == "creator:c1:1d:daily_trending:2026-09-09:Asia/Tokyo"
    assert computed_at == "2026-09-09T18:05:00+09:00"


def test_persist_rankings_never_archives_when_archive_put_is_none():
    """The default (no archive_put given) must not raise or attempt to archive
    at all -- existing callers/tests that don't care about archiving are
    completely unaffected."""
    rankings = {("creator", "c1"): {"1d": [_ranked("v1", "c1", value=100, rank=1)]}}

    writes = ranking_reducer.persist_rankings(
        rankings,
        report_date=date(2026, 9, 9),
        creators={},
        get_video=lambda video_id: None,
        put_cached_trending=lambda key, payload, *, computed_at: None,
        computed_at="2026-09-09T18:05:00+09:00",
        wru_budget=_instant_budget(),
    )

    assert writes == 1


def test_lambda_handler_archives_every_cache_write_via_the_real_archive_store(monkeypatch):
    """End-to-end: lambda_handler must actually construct and wire in
    S3TrendingCacheArchiveStore.from_environment() -- not just have the
    plumbing available and unused."""
    report_date = date(2026, 9, 9)
    client = _CountingS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)
    rankings = {("creator", "c1"): {"1d": [_ranked("v1", "c1", value=100, rank=1)]}}
    store.write(report_date, 0, rankings)
    for shard in range(1, HISTORY_SHARD_COUNT):
        store.write(report_date, shard, {})

    monkeypatch.setattr(ranking_reducer, "S3PartialRankingStore", lambda bucket_name: store)
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", "test-bucket")
    monkeypatch.setattr(dynamodb_store, "get_video", lambda video_id: None)
    monkeypatch.setattr(ranking_reducer, "load_creators", lambda: [_creator("c1", organization="vspo")])
    monkeypatch.setattr(execution_lock, "renew_execution_lock", lambda **kwargs: None)
    monkeypatch.setattr(dynamodb_store, "put_cached_trending", lambda key, payload, *, computed_at: None)
    recording_store = _RecordingArchiveStore()
    monkeypatch.setattr(ranking_reducer, "S3TrendingCacheArchiveStore", recording_store)

    result = ranking_reducer.lambda_handler({"reportDate": report_date.isoformat(), "ownerToken": "exec-1"}, None)

    assert result["cacheWrites"] > 0
    assert len(recording_store.puts) == result["cacheWrites"]
    archived_keys = {key for key, _, _ in recording_store.puts}
    assert "creator:c1:1d:daily_trending:2026-09-09:Asia/Tokyo" in archived_keys


def test_organization_scope_write_key_matches_get_organization_trending_contract():
    """Cross-contract regression (V5.11/V5.12): the exact cache key
    persist_rankings writes for an organization-scoped ranking must be the
    same key get_organization_trending's own cache lookup builds for the
    identical organization/period/rankingType/reportDate.

    Exercises the real history_ranking.top_n_by_scope computation -- not a
    hand-constructed rankings dict -- so this fails if a future change ever
    renames the reducer's own organization scope_type (history_ranking.
    _scopes_for) without updating the API to match, or vice versa: exactly
    the class of bug V5.11 found already shipped and undetected (reducer
    wrote "organization:", the API read "org:", and every existing test
    checked each side in isolation without ever comparing them).
    """
    from analytics.history_ranking import CreatorDimensions, top_n_by_scope
    from stores.history_store import HistoryRow
    from api.read_api import trending_cache_key

    report_date = date(2026, 9, 9)
    today_row = HistoryRow(
        video_id="v1", creator_id="c1", view_count=200, observed_at="2026-09-09T18:00:00+09:00",
        availability_status="available",
    )
    anchor_row = HistoryRow(
        video_id="v1", creator_id="c1", view_count=100, observed_at="2026-09-08T18:00:00+09:00",
        availability_status="available",
    )
    dimensions = {"c1": CreatorDimensions(organization="vspo", branch="vspo_jp")}

    rankings = top_n_by_scope(
        [today_row], {1: [anchor_row], 7: [], 30: []}, report_date=report_date, dimensions_by_creator=dimensions
    )

    cache_writes: list[str] = []
    ranking_reducer.persist_rankings(
        rankings,
        report_date=report_date,
        creators={"c1": _creator("c1", organization="vspo")},
        get_video=lambda video_id: None,
        put_cached_trending=lambda key, payload, *, computed_at: cache_writes.append(key),
        computed_at="2026-09-09T18:00:05+09:00",
        wru_budget=_instant_budget(),
    )

    # ":vspo:" (with trailing colon) uniquely picks out the organization-scope
    # write among global/creator(c1)/org(vspo)/branch(vspo_jp) -- branch's own
    # key contains "vspo_jp:", never the bare "vspo:" segment.
    actual_key = next(key for key in cache_writes if ":vspo:" in key)
    expected_key = trending_cache_key(
        scope_type="org", scope_value="vspo", period="1d", ranking_type="daily_trending", report_date=report_date
    )

    assert actual_key == expected_key
    assert actual_key.startswith("org:")


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
        store.write(report_date, shard, {})

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


# --- R7 safety correction: real end-to-end schemaVersion=2 compatibility ---
# --- across a rolling deploy (history_worker and ranking_reducer are two --
# --- separately-deployed Lambdas, so one day's 16 shards can legitimately --
# --- mix old- and new-shaped objects) --------------------------------------


def test_lambda_handler_tolerates_a_mix_of_old_and_new_shaped_shard_objects(monkeypatch):
    """One report date's 16 shard objects can legitimately be a mix: some
    written by an already-upgraded history_worker Lambda (no topicPartials
    key, "creator"/"org" scopes only) and some still written by an
    old (pre-R7) one (a real topicPartials array, plus "branch"/"global"
    scope entries the old _scopes_for still produced) -- Lambda functions in
    this repo are deployed independently, so this is a real production
    possibility during a rolling deploy, not just a hypothetical.

    The current (post-R7/R8B) ranking_reducer.lambda_handler must process
    every shard without raising: the old shard's extra topicPartials AND
    creatorPartials keys are simply ignored (Direction A -- new code reading
    an old bundle), and its "branch"/"global" scope entries are still
    written to TrendingCache without a KeyError (ranking_reducer._scope_field
    still recognizes them, deliberately left in place for exactly this
    transitional window). creatorPartials here is a real, non-empty array
    (not just an empty list a bug could satisfy by accident) to prove it is
    genuinely unread, not merely absent.

    R8B (AWS Cost Recovery): the reverse direction (an old, not-yet-upgraded
    reducer reading a *new* bundle that omits creatorPartials entirely) is
    NOT covered here and is not safe from this repo alone -- unlike
    topicPartials, which was always read tolerantly (`payload.get(...)`, see
    that field's own original introduction), creatorPartials was a required
    v2 key from the start, so an already-deployed pre-R8B reducer would
    KeyError on a creatorPartials-less bundle. See ranking_partial_store.py's
    own R8B note for the full explanation; closing that window is a
    deploy-ordering concern (reducer before/with history_worker), not
    something this diff can encode.
    """
    report_date = date(2026, 9, 9)
    client = _CountingS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)

    # Shard 0: simulates an old (pre-R7/R8B) history_worker Lambda's own
    # output -- written directly as raw bytes (the real old write() call no
    # longer exists in this repo to invoke), old-shaped: creator+org+branch+
    # global scopes, plus real topicPartials/creatorPartials arrays.
    old_shaped_payload = {
        "schemaVersion": 2,
        "scopeRankings": [
            {"scopeType": "creator", "scopeValue": "old_creator", "period": "7d",
             "entries": [{"rank": 1, "videoId": "old_v1", "creatorId": "old_creator", "viewCount": 300,
                          "anchorViewCount": 0, "gain": 300, "observedAt": "2026-09-09T18:00:00+09:00"}]},
            {"scopeType": "branch", "scopeValue": "vspo_jp", "period": "7d",
             "entries": [{"rank": 1, "videoId": "old_v1", "creatorId": "old_creator", "viewCount": 300,
                          "anchorViewCount": 0, "gain": 300, "observedAt": "2026-09-09T18:00:00+09:00"}]},
            {"scopeType": "global", "scopeValue": "global", "period": "7d",
             "entries": [{"rank": 1, "videoId": "old_v1", "creatorId": "old_creator", "viewCount": 300,
                          "anchorViewCount": 0, "gain": 300, "observedAt": "2026-09-09T18:00:00+09:00"}]},
        ],
        "creatorPartials": [
            {"creatorId": "old_creator", "period": "7d", "viewSum": 300, "catalogVideoCount": 1,
             "eligibleVideoCount": 1, "topCandidates": []},
        ],
        "topicPartials": [{"creatorId": "old_creator", "topic": "apex", "viewSum": 300, "videoCount": 1}],
    }
    client.objects[partial_ranking_key(report_date, 0)] = json.dumps(old_shaped_payload).encode("utf-8")

    # Shards 1..15: normal, current-code writes (new-shaped, no topicPartials/
    # creatorPartials, creator/org scope only).
    for shard in range(1, HISTORY_SHARD_COUNT):
        store.write(report_date, shard, {})

    monkeypatch.setattr(ranking_reducer, "S3PartialRankingStore", lambda bucket_name: store)
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", "test-bucket")
    monkeypatch.setattr(dynamodb_store, "get_video", lambda video_id: None)
    monkeypatch.setattr(ranking_reducer, "load_creators", lambda: [_creator("old_creator", organization="vspo")])
    monkeypatch.setattr(execution_lock, "renew_execution_lock", lambda **kwargs: None)
    monkeypatch.setattr(ranking_reducer, "S3TrendingCacheArchiveStore", _NoArchiveStore)
    cache_writes = []
    monkeypatch.setattr(
        dynamodb_store, "put_cached_trending", lambda key, payload, *, computed_at: cache_writes.append((key, payload))
    )

    result = ranking_reducer.lambda_handler({"reportDate": report_date.isoformat(), "ownerToken": "exec-1"}, None)

    keys_written = {key for key, _ in cache_writes}
    # No exception was raised (the assertion above already proves it, since
    # lambda_handler would have propagated one) -- the old shard's branch/
    # global scope entries were still written (no KeyError from _scope_field)...
    assert any(key.startswith("branch:vspo_jp:") for key in keys_written)
    assert any(key.startswith("global:global:") for key in keys_written)
    assert any(key.startswith("creator:old_creator:") for key in keys_written)
    # ...and its topicPartials/creatorPartials data produced no topicLeaderboard
    # or creatorSummary write at all (both whole write paths were removed).
    assert not any(key.startswith("topicLeaderboard:") for key in keys_written)
    assert not any(key.startswith("creatorSummary:") for key in keys_written)
    assert result["cacheWrites"] == len(cache_writes)


# --- WruBudget pacing (shared across every persist_rankings call one invocation makes) --


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


def test_wru_budget_is_shared_and_cumulative_across_multiple_persist_calls():
    """Two separate persist_rankings calls given the *same* WruBudget must
    charge into the same running total -- proving a shared budget, not one
    that resets or forks per call, which is what lets lambda_handler pace
    every write it makes across a whole invocation against one real
    table-wide cap."""
    clock, sleeper, slept = _fake_clock_and_sleeper()
    budget = ranking_reducer.WruBudget(target_wru_per_second=1_000_000, clock=clock, sleeper=sleeper)

    rankings_c1 = {("creator", "c1"): {"7d": [_ranked("v1", "c1", value=100, rank=1)]}}
    ranking_reducer.persist_rankings(
        rankings_c1,
        report_date=date(2026, 9, 9),
        creators={},
        get_video=lambda video_id: None,
        put_cached_trending=lambda key, payload, *, computed_at: None,
        computed_at="2026-09-09T18:05:00+09:00",
        wru_budget=budget,
    )
    wru_after_first_call = budget.total_wru
    assert wru_after_first_call > 0

    rankings_c2 = {("creator", "c2"): {"7d": [_ranked("v2", "c2", value=200, rank=1)]}}
    ranking_reducer.persist_rankings(
        rankings_c2,
        report_date=date(2026, 9, 9),
        creators={},
        get_video=lambda video_id: None,
        put_cached_trending=lambda key, payload, *, computed_at: None,
        computed_at="2026-09-09T18:05:00+09:00",
        wru_budget=budget,
    )

    # The second call's writes must have been *added* to the first call's
    # running total, never a fresh/reset budget.
    assert budget.total_wru > wru_after_first_call


# --- _dynamodb_item_bytes: the real item size, not just payload's own JSON size --


def test_dynamodb_item_bytes_includes_cache_key_and_computed_at_not_just_payload():
    """dynamodb_store.put_cached_trending's actual Item is
    {"cacheKey": ..., "payload": json.dumps(payload), "computedAt": ...,
    "ttlAt": <epoch seconds>} -- three String attributes plus one Number
    attribute (AWS Cost Recovery third pass, Scope F). Measuring payload's
    own JSON size alone (an earlier version of this estimator) undercounts
    by every other attribute's name and value bytes."""
    cache_key = "creatorSummary:c1:7d:2026-09-09"
    payload = {"a": 1}
    computed_at = "2026-09-09T18:05:00+09:00"

    payload_only_bytes = len(json.dumps(payload).encode("utf-8"))
    full_item_bytes = ranking_reducer._dynamodb_item_bytes(cache_key=cache_key, payload=payload, computed_at=computed_at)

    assert full_item_bytes > payload_only_bytes
    ttl_at = dynamodb_store._compute_ttl_at(computed_at)
    expected = (
        len("cacheKey".encode("utf-8")) + len(cache_key.encode("utf-8"))
        + len("payload".encode("utf-8")) + len(json.dumps(payload).encode("utf-8"))
        + len("computedAt".encode("utf-8")) + len(computed_at.encode("utf-8"))
        + len("ttlAt".encode("utf-8")) + len(str(ttl_at).encode("utf-8"))
    )
    assert full_item_bytes == expected


def test_item_bytes_boundary_1024_charges_1_wru_and_1025_charges_2_wru():
    """Exactly 1024 bytes must charge 1 WRU; one byte more (1025) must charge
    2 -- ceil(bytes/1024), the real DynamoDB write-unit rounding rule,
    exercised through the actual item-size computation, not a hand-picked
    byte count handed straight to WruBudget.charge()."""

    fixed_computed_at = "2026-09-09T18:05:00+09:00"

    def item_bytes(padding_len):
        payload = {"pad": "x" * padding_len}
        return ranking_reducer._dynamodb_item_bytes(cache_key="k", payload=payload, computed_at=fixed_computed_at)

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
    computed_at = "2026-09-09T18:05:00+09:00"

    computed = ranking_reducer._dynamodb_item_bytes(cache_key=unicode_key, payload=payload, computed_at=computed_at)

    ttl_at = dynamodb_store._compute_ttl_at(computed_at)
    utf8_byte_sum = (
        len("cacheKey".encode("utf-8")) + len(unicode_key.encode("utf-8"))
        + len("payload".encode("utf-8")) + len(json.dumps(payload).encode("utf-8"))
        + len("computedAt".encode("utf-8")) + len(computed_at.encode("utf-8"))
        + len("ttlAt".encode("utf-8")) + len(str(ttl_at).encode("utf-8"))
    )
    naive_code_point_sum = (
        len("cacheKey") + len(unicode_key) + len("payload") + len(json.dumps(payload)) + len("computedAt") + len(computed_at)
        + len("ttlAt") + len(str(ttl_at))
    )

    assert computed == utf8_byte_sum
    assert computed > naive_code_point_sum  # proves the multi-byte characters were actually counted as multiple bytes
