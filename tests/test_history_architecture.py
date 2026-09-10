import os
import subprocess
import sys
from datetime import date

import pytest
from botocore.exceptions import ClientError

import history_worker
import history_worker_handler
from history_ranking import (
    CreatorDimensions,
    exact_gains,
    load_exact_anchor_rows,
    merge_partial_rankings,
    top_n_by_scope,
)
from history_store import (
    HISTORY_SHARD_COUNT,
    HistoryRow,
    HistoryStoreError,
    S3HistoryStore,
    daily_history_key,
    deserialize_history_rows,
    monthly_history_key,
    serialize_history_rows,
    shard_for_video,
)
from history_worker import collect_history_shard
from tracking_manifest import (
    ManifestEntry,
    TrackingManifestError,
    deserialize_manifest,
    manifest_key,
    serialize_manifest,
)


def _row(video_id, count, creator_id="c1"):
    return HistoryRow(
        video_id=video_id,
        creator_id=creator_id,
        view_count=count,
        observed_at="2026-09-09T18:00:00+09:00",
        availability_status="available",
    )


def _video_for_shard(shard):
    index = 0
    while True:
        video_id = f"video-{shard}-{index}"
        if shard_for_video(video_id) == shard:
            return video_id
        index += 1


def test_video_id_shard_mapping_is_stable_and_in_range():
    first = shard_for_video("youtube-video-123")
    assert first == shard_for_video("youtube-video-123")
    assert 0 <= first < HISTORY_SHARD_COUNT


def test_video_id_shard_mapping_is_stable_across_processes():
    script = "from history_store import shard_for_video; print(shard_for_video('youtube-video-123'))"
    environment = {**os.environ, "PYTHONPATH": str(os.path.join(os.path.dirname(__file__), "..", "src"))}
    values = [
        subprocess.check_output([sys.executable, "-c", script], env=environment, text=True).strip()
        for _ in range(2)
    ]
    assert values[0] == values[1] == str(shard_for_video("youtube-video-123"))


def test_daily_monthly_and_manifest_keys_are_deterministic():
    assert daily_history_key(date(2026, 9, 9), 0) == "history/daily/date=2026-09-09/shard=00.parquet"
    assert daily_history_key(date(2026, 9, 9), 15) == "history/daily/date=2026-09-09/shard=15.parquet"
    assert monthly_history_key(2026, 9, 3) == "history/monthly/year=2026/month=09/shard=03.parquet"
    assert manifest_key(7) == "catalog/current/shard=07.parquet"


def test_history_parquet_round_trip_uses_minimal_schema():
    rows = [_row("v2", 20), _row("v1", 10)]
    payload = serialize_history_rows(rows)
    restored = deserialize_history_rows(payload)
    assert restored == rows

    import pyarrow.parquet as parquet
    import pyarrow as pa

    table = parquet.read_table(pa.BufferReader(payload))
    assert table.column_names == [
        "videoId",
        "creatorId",
        "viewCount",
        "observedAt",
        "availabilityStatus",
    ]


def test_manifest_parquet_round_trip():
    entries = [ManifestEntry("v1", "c1", True), ManifestEntry("v2", "c2", False)]
    assert deserialize_manifest(serialize_manifest(entries)) == entries


def test_manifest_parquet_round_trip_carries_discovered_at():
    entries = [ManifestEntry("v1", "c1", True, discovered_at="2026-09-06T00:00:00Z")]
    assert deserialize_manifest(serialize_manifest(entries)) == entries


def test_deserialize_manifest_is_backward_compatible_with_a_parquet_file_that_has_no_discovered_at_column():
    """A manifest object written before discoveredAt existed must still
    deserialize (not raise), with every entry's discovered_at read as None --
    never inferred, and never treated as "new" by discovered_dates_by_video's
    own UNKNOWN_DISCOVERED_DATE fallback."""
    import io

    import pyarrow as pa
    import pyarrow.parquet as parquet

    old_table = pa.table(
        {
            "videoId": pa.array(["v1"], type=pa.string()),
            "creatorId": pa.array(["c1"], type=pa.string()),
            "active": pa.array([True], type=pa.bool_()),
        }
    )
    output = io.BytesIO()
    parquet.write_table(old_table, output)

    entries = deserialize_manifest(output.getvalue())

    assert entries == [ManifestEntry("v1", "c1", True, discovered_at=None)]


def test_missing_anchors_are_not_fabricated():
    """With no discovered_date_by_video given, every video's discovery date is
    unknown (history_ranking.UNKNOWN_DISCOVERED_DATE) — never treated as new,
    so a missing anchor stays a real gap (None), not a fabricated baseline."""
    today = [_row("v1", 150)]
    gains = exact_gains(today, {1: [], 7: [], 30: []}, report_date=date(2026, 9, 9))
    assert gains["v1"] == {1: None, 7: None, 30: None}
    assert top_n_by_scope(today, {1: [], 7: [], 30: []}, report_date=date(2026, 9, 9)) == {}


def test_exact_one_seven_and_thirty_day_growth():
    today = [_row("v1", 1_000)]
    gains = exact_gains(
        today,
        {1: [_row("v1", 900)], 7: [_row("v1", 700)], 30: [_row("v1", 100)]},
        report_date=date(2026, 9, 9),
    )
    assert gains["v1"] == {1: 100, 7: 300, 30: 900}


def test_exact_anchor_loader_reads_only_fixed_dates():
    class FakeStore:
        def __init__(self):
            self.reads = []

        def read_daily_shard(self, collection_date, shard):
            self.reads.append((collection_date, shard))
            return []

    store = FakeStore()
    load_exact_anchor_rows(store, report_date=date(2026, 9, 9), shard=4)
    assert store.reads == [
        (date(2026, 9, 8), 4),
        (date(2026, 9, 2), 4),
        (date(2026, 8, 10), 4),
    ]


def test_top_n_ordering_and_scopes_consider_every_video():
    today = [_row("v1", 110, "c1"), _row("v2", 500, "c1"), _row("v3", 250, "c2")]
    anchors = {
        1: [_row("v1", 100, "c1"), _row("v2", 100, "c1"), _row("v3", 100, "c2")],
        7: [],
        30: [],
    }
    dimensions = {
        "c1": CreatorDimensions("org", "branch-a"),
        "c2": CreatorDimensions("org", "branch-b"),
    }
    result = top_n_by_scope(today, anchors, report_date=date(2026, 9, 9), dimensions_by_creator=dimensions, limit=2)
    assert [entry.video_id for entry in result[("global", "global")]["1d"]] == ["v2", "v3"]
    assert [entry.video_id for entry in result[("creator", "c1")]["1d"]] == ["v2", "v1"]
    assert [entry.video_id for entry in result[("organization", "org")]["1d"]] == ["v2", "v3"]
    assert [entry.video_id for entry in result[("branch", "branch-a")]["1d"]] == ["v2", "v1"]


def test_partial_top_n_merge_preserves_global_order():
    first = top_n_by_scope([_row("a", 200)], {1: [_row("a", 100)]}, report_date=date(2026, 9, 9), limit=1)
    second = top_n_by_scope([_row("b", 500)], {1: [_row("b", 100)]}, report_date=date(2026, 9, 9), limit=1)
    merged = merge_partial_rankings([first, second], limit=1)
    assert [entry.video_id for entry in merged[("global", "global")]["1d"]] == ["b"]


def test_failed_shard_does_not_rollback_a_successful_shard(monkeypatch):
    first_shard, failed_shard = 1, 2
    ids = {first_shard: _video_for_shard(first_shard), failed_shard: _video_for_shard(failed_shard)}

    class FakeManifest:
        def read_shard(self, shard):
            return [ManifestEntry(ids[shard], "c1", True)]

    class FakeHistory:
        def __init__(self):
            self.objects = {}
            self.write_counts = {}
            self.failed_writes_remaining = 1

        def write_daily_shard(self, collection_date, shard, rows):
            self.write_counts[shard] = self.write_counts.get(shard, 0) + 1
            if shard == failed_shard and self.failed_writes_remaining:
                self.failed_writes_remaining -= 1
                raise RuntimeError("simulated shard write failure")
            self.objects[(collection_date, shard)] = list(rows)
            return daily_history_key(collection_date, shard)

        def read_daily_shard(self, collection_date, shard):
            return []

        def shard_exists(self, collection_date, shard):
            return (collection_date, shard) in self.objects

    def fake_statistics(youtube, video_ids):
        return (
            [
                {
                    "videoId": video_ids[0],
                    "title": "title",
                    "publishedAt": "2026-01-01T00:00:00Z",
                    "viewCount": 123,
                }
            ],
            {},
        )

    monkeypatch.setattr(history_worker, "get_video_statistics", fake_statistics)
    store = FakeHistory()
    kwargs = {
        "youtube": object(),
        "manifest_store": FakeManifest(),
        "history_store": store,
        "collection_date": date(2026, 9, 9),
        "observed_at": "2026-09-09T18:00:00+09:00",
    }
    collect_history_shard(shard=first_shard, **kwargs)
    with pytest.raises(RuntimeError, match="simulated shard write failure"):
        collect_history_shard(shard=failed_shard, **kwargs)
    # Retry only the failed unit. The successful shard remains untouched.
    collect_history_shard(shard=failed_shard, **kwargs)
    assert (date(2026, 9, 9), first_shard) in store.objects
    assert (date(2026, 9, 9), failed_shard) in store.objects
    assert store.write_counts == {first_shard: 1, failed_shard: 2}


# --- S3HistoryStore.shard_exists error-code branching -----------------------


class _HeadObjectErrorClient:
    """A minimal stub s3_client whose head_object always raises a controlled ClientError."""

    def __init__(self, error_code: str):
        self.error_code = error_code

    def head_object(self, **kwargs):
        raise ClientError({"Error": {"Code": self.error_code, "Message": "boom"}}, "HeadObject")


@pytest.mark.parametrize("not_found_code", ["404", "NoSuchKey", "NotFound"])
def test_s3_history_store_shard_exists_returns_false_only_for_genuine_not_found(not_found_code):
    store = S3HistoryStore("test-bucket", s3_client=_HeadObjectErrorClient(not_found_code))
    assert store.shard_exists(date(2026, 9, 9), 0) is False


@pytest.mark.parametrize("other_error_code", ["403", "500", "503", "SlowDown", "RequestLimitExceeded", "InternalError"])
def test_s3_history_store_shard_exists_reraises_every_other_error(other_error_code):
    """A permissions error, throttling, or a 5xx must never be read as 'shard
    doesn't exist' — that would silently skip real collection for the day
    (if misread as 'already collected') or defeat the whole idempotency
    check (if the caller treated a raised error as 'not collected')."""
    store = S3HistoryStore("test-bucket", s3_client=_HeadObjectErrorClient(other_error_code))
    with pytest.raises(HistoryStoreError):
        store.shard_exists(date(2026, 9, 9), 0)


# --- shard input validation (Roadmap 5.3 cost/abuse containment) -----------


class _BoomManifest:
    def read_shard(self, shard):
        raise AssertionError("manifest storage should not be touched for an invalid shard")


class _BoomHistory:
    def read_daily_shard(self, collection_date, shard):
        raise AssertionError("history storage should not be touched for an invalid shard")

    def write_daily_shard(self, collection_date, shard, rows):
        raise AssertionError("history storage should not be touched for an invalid shard")

    def shard_exists(self, collection_date, shard):
        raise AssertionError("history storage should not be touched for an invalid shard")


@pytest.mark.parametrize("bad_shard", [-1, HISTORY_SHARD_COUNT, HISTORY_SHARD_COUNT + 100, "0", 1.5, True])
def test_collect_history_shard_rejects_an_out_of_range_shard_before_touching_storage(bad_shard):
    """The Step Functions Map's shard list is execution input, not baked into the
    state machine definition (terraform/eventbridge.tf's `range(16)`) — a malformed
    or adversarial StartExecution input must never reach manifest/history storage."""
    with pytest.raises(ValueError):
        collect_history_shard(
            youtube=object(),
            manifest_store=_BoomManifest(),
            history_store=_BoomHistory(),
            collection_date=date(2026, 9, 9),
            shard=bad_shard,
            observed_at="2026-09-09T18:00:00+09:00",
        )


@pytest.mark.parametrize("bad_shard", [-1, HISTORY_SHARD_COUNT, "not-a-number", 1.5, True, None])
def test_history_worker_handler_validate_shard_rejects_bad_values(bad_shard):
    with pytest.raises(ValueError):
        history_worker_handler._validate_shard(bad_shard)


def test_history_worker_handler_validate_shard_accepts_every_real_shard():
    for shard in range(HISTORY_SHARD_COUNT):
        assert history_worker_handler._validate_shard(shard) == shard
        assert history_worker_handler._validate_shard(str(shard)) == shard


# --- state-machine-input-level shard-list validation (Roadmap 5.3) ---------


@pytest.mark.parametrize(
    "shards",
    [list(range(HISTORY_SHARD_COUNT)), [3], [0, 15], ["0", "1"]],
    ids=["full_set", "single_retry", "sparse_subset", "numeric_strings"],
)
def test_validate_shards_accepts_a_full_or_partial_real_shard_set(shards):
    """A manual rerun of just one (or a few) failed shards is a legitimate
    operational case, not an abuse pattern — only the whole array's own shape
    (empty, too long, duplicated, out-of-range) is what's rejected."""
    result = history_worker_handler._validate_shards(shards)
    assert result == [int(s) for s in shards]


@pytest.mark.parametrize(
    "bad_shards",
    [
        [],
        "not-a-list",
        None,
        list(range(HISTORY_SHARD_COUNT + 1)),
        [0] * (HISTORY_SHARD_COUNT + 5),
        [0, 0, 1],
        [-1, 0, 1],
        [0, 1, HISTORY_SHARD_COUNT],
        [0, "not-a-number"],
    ],
    ids=[
        "empty",
        "not_a_list",
        "none",
        "too_many_entries",
        "oversized_duplicated_array",
        "duplicate_shard",
        "negative_shard",
        "out_of_range_shard",
        "non_integer_element",
    ],
)
def test_validate_shards_rejects_malformed_or_adversarial_input(bad_shards):
    """This is the guard that stands between a malformed/adversarial
    StartExecution input (e.g. thousands of repeated shard entries) and the
    Step Functions Map fanning every one of them out into its own Lambda
    invocation — every case here must be rejected in this one call, before
    any Map iteration is ever dispatched."""
    with pytest.raises(ValueError):
        history_worker_handler._validate_shards(bad_shards)


def test_lambda_handler_validates_a_shards_event_without_any_other_setup():
    """terraform/history.tf's ValidateShardsInput state invokes this same Lambda
    with a `shards` (plural) event — it must branch and return before doing any
    of the real per-shard setup (YouTube client, Creator Master, S3 stores),
    which is exactly why no monkeypatching is needed to exercise this path.

    The exact `{"shards": [...]}` return shape (not a bare list) is also the
    data-flow contract ValidateShardsInput's ResultPath="$"/OutputPath="$.Payload"
    combination in the state machine depends on to reconstruct $.shards for the
    Map that follows — see that state's own comment in terraform/history.tf."""
    assert history_worker_handler.lambda_handler({"shards": [0, 1, 2]}, None) == {"shards": [0, 1, 2]}

    with pytest.raises(ValueError):
        history_worker_handler.lambda_handler({"shards": [0, 0, 1]}, None)


def test_collect_history_shard_skips_youtube_when_the_shard_is_already_collected_today(monkeypatch):
    """A retry of an already-succeeded shard, or the same shard number appearing
    twice in one Map's input, must never call YouTube a second time for the same
    day — only the (free, local) ranking is recomputed from the persisted rows."""
    shard = 3
    video_id = _video_for_shard(shard)
    existing_rows = [_row(video_id, 500)]

    class FakeManifest:
        def read_shard(self, shard):
            return [ManifestEntry(video_id, "c1", True)]

    class FakeHistory:
        def shard_exists(self, collection_date, shard):
            return True

        def read_daily_shard(self, collection_date, shard):
            return existing_rows

        def write_daily_shard(self, collection_date, shard, rows):
            raise AssertionError("an already-collected shard must not be rewritten")

    def _boom_statistics(youtube, video_ids):
        raise AssertionError("YouTube must not be called for an already-collected shard")

    monkeypatch.setattr(history_worker, "get_video_statistics", _boom_statistics)

    result = collect_history_shard(
        youtube=object(),
        manifest_store=FakeManifest(),
        history_store=FakeHistory(),
        collection_date=date(2026, 9, 9),
        shard=shard,
        observed_at="2026-09-09T18:00:00+09:00",
    )

    assert result.rows == existing_rows
    assert result.history_key == daily_history_key(date(2026, 9, 9), shard)
    # The idempotent-skip path must still produce a creator-period partial for
    # this shard's write() — the only place that writes it for the day — not
    # omit it just because YouTube itself was skipped.
    assert result.creator_partials["c1"]["all"].view_sum == 500
    assert result.creator_partials["c1"]["all"].eligible_video_count == 1


def test_collect_history_shard_skips_youtube_for_a_shard_that_legitimately_collected_zero_rows(monkeypatch):
    """A shard can legitimately collect zero rows (every video in it was unavailable
    that day) and still have been successfully written. shard_exists (not "are
    there any rows") must be what a retry/duplicate checks — using row count alone
    would treat this shard as never-collected and re-call YouTube every time."""
    shard = 5
    video_id = _video_for_shard(shard)

    class FakeManifest:
        def read_shard(self, shard):
            return [ManifestEntry(video_id, "c1", True)]

    class FakeHistory:
        def shard_exists(self, collection_date, shard):
            return True  # written today, even though it holds zero rows

        def read_daily_shard(self, collection_date, shard):
            return []

        def write_daily_shard(self, collection_date, shard, rows):
            raise AssertionError("an already-collected (even if empty) shard must not be rewritten")

    def _boom_statistics(youtube, video_ids):
        raise AssertionError("YouTube must not be called for an already-collected shard")

    monkeypatch.setattr(history_worker, "get_video_statistics", _boom_statistics)

    result = collect_history_shard(
        youtube=object(),
        manifest_store=FakeManifest(),
        history_store=FakeHistory(),
        collection_date=date(2026, 9, 9),
        shard=shard,
        observed_at="2026-09-09T18:00:00+09:00",
    )

    assert result.rows == []
    assert result.creator_partials == {}


def test_collect_history_shard_idempotent_skip_produces_the_same_creator_partial_as_a_fresh_compute(monkeypatch):
    """A retry that skips YouTube (because the shard already exists) must
    produce byte-for-byte the same creator-period partial a fresh compute
    over the same underlying rows would — the reducer's later merge must
    never see a gap just because a particular invocation happened to skip
    YouTube."""
    shard = 7
    video_id = _video_for_shard(shard)

    class FreshManifest:
        def read_shard(self, shard):
            return [ManifestEntry(video_id, "c1", True)]

    class FreshHistory:
        def shard_exists(self, collection_date, shard):
            return False

        def read_daily_shard(self, collection_date, shard):
            return []

        def write_daily_shard(self, collection_date, shard, rows):
            return daily_history_key(collection_date, shard)

    def fake_statistics(youtube, video_ids):
        return (
            [{"videoId": video_id, "title": "t", "publishedAt": "2026-01-01T00:00:00Z", "viewCount": 777}],
            {},
        )

    monkeypatch.setattr(history_worker, "get_video_statistics", fake_statistics)

    fresh_result = collect_history_shard(
        youtube=object(),
        manifest_store=FreshManifest(),
        history_store=FreshHistory(),
        collection_date=date(2026, 9, 9),
        shard=shard,
        observed_at="2026-09-09T18:00:00+09:00",
    )

    class SkipManifest:
        def read_shard(self, shard):
            return [ManifestEntry(video_id, "c1", True)]

    class SkipHistory:
        def shard_exists(self, collection_date, shard):
            return True

        def read_daily_shard(self, collection_date, shard):
            # load_exact_anchor_rows calls this same method for D-1/D-7/D-30
            # too -- only "today" should return the pre-collected rows,
            # matching FreshHistory's own (empty) anchors below.
            if collection_date == date(2026, 9, 9):
                return fresh_result.rows
            return []

        def write_daily_shard(self, collection_date, shard, rows):
            raise AssertionError("an already-collected shard must not be rewritten")

    def _boom_statistics(youtube, video_ids):
        raise AssertionError("YouTube must not be called for an already-collected shard")

    monkeypatch.setattr(history_worker, "get_video_statistics", _boom_statistics)

    skip_result = collect_history_shard(
        youtube=object(),
        manifest_store=SkipManifest(),
        history_store=SkipHistory(),
        collection_date=date(2026, 9, 9),
        shard=shard,
        observed_at="2026-09-09T18:00:00+09:00",
    )

    assert skip_result.creator_partials == fresh_result.creator_partials
    assert skip_result.creator_partials["c1"]["all"].view_sum == 777


# --- manifest fail-fast validation (Roadmap 5.3 cost/abuse containment) ----


def test_deserialize_manifest_rejects_duplicate_video_ids():
    """Each video belongs to exactly one deterministic shard — the same video_id
    appearing twice within one shard's own entries means the manifest itself is
    corrupt, and must be rejected before a collection worker fetches it twice."""
    import pyarrow as pa
    import pyarrow.parquet as parquet
    import io

    table = pa.table(
        {
            "videoId": pa.array(["v1", "v1"], type=pa.string()),
            "creatorId": pa.array(["c1", "c1"], type=pa.string()),
            "active": pa.array([True, True], type=pa.bool_()),
        }
    )
    output = io.BytesIO()
    parquet.write_table(table, output)

    with pytest.raises(TrackingManifestError, match="duplicate"):
        deserialize_manifest(output.getvalue())


def test_deserialize_manifest_rejects_an_entry_with_an_empty_required_field():
    """serialize_manifest already refuses to write an entry with an empty
    video_id/creator_id (_validate_entry) — deserialize_manifest must reject one
    too, in case the stored object was ever corrupted or hand-edited after the
    fact, rather than letting an empty video_id reach the YouTube API call."""
    import pyarrow as pa
    import pyarrow.parquet as parquet
    import io

    table = pa.table(
        {
            "videoId": pa.array(["v1", ""], type=pa.string()),
            "creatorId": pa.array(["c1", "c2"], type=pa.string()),
            "active": pa.array([True, True], type=pa.bool_()),
        }
    )
    output = io.BytesIO()
    parquet.write_table(table, output)

    with pytest.raises(TrackingManifestError):
        deserialize_manifest(output.getvalue())
