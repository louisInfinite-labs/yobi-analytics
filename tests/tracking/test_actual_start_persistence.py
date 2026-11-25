"""F37: actualStartAt survives every persistence boundary (Video Master raw, manifest Parquet, ranking row) and is omitted when unknown."""

import io

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from analytics.video_ranking import build_creator_video_catalog
from analytics.video_ranking_result import build_video_ranking_result
from stores.history_store import HistoryRow
from tracking.tracking_manifest import ManifestEntry, TrackingManifestError, deserialize_manifest, serialize_manifest
from tracking.video_master import Video, VideoMasterError, _parse_video, _to_raw

START = "2026-09-14T15:30:00+00:00"


def _video(**fields):
    """A minimal Video with the given overrides."""
    return Video(video_id="v1", creator_id="c1", title="T", published_at="2026-09-14T17:00:00+00:00", **fields)


def test_video_master_raw_round_trip_and_omission():
    """The field is written only when set, read back unchanged, and a record without it parses as None."""
    assert "actualStartAt" not in _to_raw(_video())
    raw = _to_raw(_video(actual_start_at=START))
    assert raw["actualStartAt"] == START
    assert _parse_video(raw).actual_start_at == START
    assert _parse_video({k: v for k, v in raw.items() if k != "actualStartAt"}).actual_start_at is None


def test_video_master_rejects_a_malformed_start():
    """A malformed persisted start makes the record invalid, like discoveredAt (never silently repaired)."""
    with pytest.raises(VideoMasterError):
        _parse_video({**_to_raw(_video()), "actualStartAt": "yesterday"})


def test_manifest_parquet_round_trip():
    """The manifest carries the start through serialize/deserialize."""
    entries = [ManifestEntry("v1", "c1", actual_start_at=START), ManifestEntry("v2", "c1")]
    restored = {e.video_id: e for e in deserialize_manifest(serialize_manifest(entries))}
    assert restored["v1"].actual_start_at == START
    assert restored["v2"].actual_start_at is None


def test_manifest_written_before_the_field_existed_still_loads():
    """A Parquet object with no actualStartAt column (every manifest in production today) reads as None, not KeyError."""
    table = pa.table({"videoId": ["v1"], "creatorId": ["c1"], "active": [True]})
    buffer = io.BytesIO()
    pq.write_table(table, buffer)
    [entry] = deserialize_manifest(buffer.getvalue())
    assert entry.actual_start_at is None


def test_manifest_rejects_a_malformed_start():
    """Writing a manifest entry with an unparseable start fails validation."""
    with pytest.raises(TrackingManifestError):
        serialize_manifest([ManifestEntry("v1", "c1", actual_start_at="soon")])


def test_ranking_result_carries_the_start_only_when_known():
    """actualStartAt is serialized for a row that has one and absent (no null key) otherwise."""
    today = [HistoryRow("a", "c1", 5, "2026-10-27T09:00:00+00:00", "available"), HistoryRow("b", "c1", 7, "2026-10-27T09:00:00+00:00", "available")]
    from datetime import date

    catalog = build_creator_video_catalog(
        today,
        {1: [], 7: [], 30: []},
        creator_id="c1",
        report_date=date(2026, 10, 27),
        topic_by_video={},
        actual_start_at_by_video={"a": START},
    )
    rows = {r["videoId"]: r for r in build_video_ranking_result(report_date=date(2026, 10, 27), creator_id="c1", generated_at="2026-10-27T09:00:00+00:00", rows=catalog)["videos"]}
    assert rows["a"]["actualStartAt"] == START
    assert "actualStartAt" not in rows["b"]
