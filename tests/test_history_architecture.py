import os
import subprocess
import sys
from datetime import date

import pytest

import history_worker
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
    daily_history_key,
    deserialize_history_rows,
    monthly_history_key,
    serialize_history_rows,
    shard_for_video,
)
from history_worker import collect_history_shard
from tracking_manifest import (
    ManifestEntry,
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


def test_missing_anchors_are_not_fabricated():
    today = [_row("v1", 150)]
    gains = exact_gains(today, {1: [], 7: [], 30: []})
    assert gains["v1"] == {1: None, 7: None, 30: None}
    assert top_n_by_scope(today, {1: [], 7: [], 30: []}) == {}


def test_exact_one_seven_and_thirty_day_growth():
    today = [_row("v1", 1_000)]
    gains = exact_gains(
        today,
        {1: [_row("v1", 900)], 7: [_row("v1", 700)], 30: [_row("v1", 100)]},
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
    result = top_n_by_scope(today, anchors, dimensions_by_creator=dimensions, limit=2)
    assert [entry.video_id for entry in result[("global", "global")]["1d"]] == ["v2", "v3"]
    assert [entry.video_id for entry in result[("creator", "c1")]["1d"]] == ["v2", "v1"]
    assert [entry.video_id for entry in result[("organization", "org")]["1d"]] == ["v2", "v3"]
    assert [entry.video_id for entry in result[("branch", "branch-a")]["1d"]] == ["v2", "v1"]


def test_partial_top_n_merge_preserves_global_order():
    first = top_n_by_scope([_row("a", 200)], {1: [_row("a", 100)]}, limit=1)
    second = top_n_by_scope([_row("b", 500)], {1: [_row("b", 100)]}, limit=1)
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
