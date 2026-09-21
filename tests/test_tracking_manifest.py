import io

import pyarrow as pa
import pytest

from tracking.tracking_manifest import (
    ManifestEntry,
    TrackingManifestError,
    deserialize_manifest,
    publish_tracking_manifest,
    serialize_manifest,
)
from tracking.video_master import Video


class _RecordingManifestStore:
    """A tracking-manifest store stub that records every write_shard call, for
    asserting exactly what publish_tracking_manifest built without touching S3."""

    def __init__(self):
        self.written: dict[int, list[ManifestEntry]] = {}

    def write_shard(self, shard, entries):
        self.written[shard] = entries
        return f"catalog/current/shard={shard:02d}.parquet"

    def read_shard(self, shard):
        raise NotImplementedError


def test_manifest_parquet_round_trip_carries_published_at_and_activity_state():
    """serialize_manifest writes publishedAt/activityState, and deserialize_manifest
    reads both back unchanged (Roadmap 1.5 tier-scheduler inputs)."""
    entries = [
        ManifestEntry(
            "v1",
            "c1",
            True,
            discovered_at="2026-09-06T00:00:00Z",
            published_at="2026-08-01T00:00:00Z",
            activity_state="Warm",
        )
    ]

    assert deserialize_manifest(serialize_manifest(entries)) == entries


def test_manifest_parquet_round_trip_still_works_with_published_at_and_activity_state_absent():
    """A freshly-built entry with no tier-scheduler data yet (both None) still
    round-trips -- None is a legitimate, explicit value here, not an error."""
    entries = [ManifestEntry("v1", "c1", True)]

    assert deserialize_manifest(serialize_manifest(entries)) == entries
    assert entries[0].published_at is None
    assert entries[0].activity_state is None


def test_deserialize_manifest_is_backward_compatible_with_a_parquet_file_that_has_no_tier_scheduler_columns():
    """A manifest object written before this schema extension (no publishedAt/
    activityState columns at all) must still deserialize -- read as None on both
    fields, never inferred from discoveredAt and never defaulted to a guessed
    business classification like "Unknown"/"Hot"/"Warm"/"Cold"."""
    old_table = pa.table(
        {
            "videoId": pa.array(["v1"], type=pa.string()),
            "creatorId": pa.array(["c1"], type=pa.string()),
            "active": pa.array([True], type=pa.bool_()),
        }
    )
    output = io.BytesIO()
    import pyarrow.parquet as parquet

    parquet.write_table(old_table, output)

    entries = deserialize_manifest(output.getvalue())

    assert entries == [ManifestEntry("v1", "c1", True, published_at=None, activity_state=None)]


def test_publish_tracking_manifest_maps_video_master_fields_directly():
    """publish_tracking_manifest reads published_at/activity_state straight off the
    Video Master objects it's given -- no extra DynamoDB/store lookup -- and writes
    them into the corresponding manifest entry unchanged."""
    video = Video(
        video_id="v1",
        creator_id="c1",
        title="Title",
        published_at="2026-08-01T00:00:00Z",
        activity_state="Hot",
    )
    store = _RecordingManifestStore()

    publish_tracking_manifest([video], store)

    written_entries = [entry for entries in store.written.values() for entry in entries]
    assert len(written_entries) == 1
    entry = written_entries[0]
    assert entry.published_at == "2026-08-01T00:00:00Z"
    assert entry.activity_state == "Hot"


def test_publish_tracking_manifest_preserves_default_unknown_activity_state():
    """A Video that has never been classified yet still bootstraps as "Unknown" --
    a genuine business value here, not the None used for a pre-migration manifest."""
    video = Video(video_id="v1", creator_id="c1", title="Title", published_at="2026-08-01T00:00:00Z")
    store = _RecordingManifestStore()

    publish_tracking_manifest([video], store)

    entry = next(entry for entries in store.written.values() for entry in entries)
    assert entry.activity_state == "Unknown"


def test_serialize_manifest_rejects_empty_published_at():
    """An entry that sets published_at to an empty string (rather than the real
    "absent" value, None) is rejected -- distinguishing "genuinely missing" from
    "someone wrote a blank value" matters, and only the former is tolerated."""
    entries = [ManifestEntry("v1", "c1", True, published_at="")]

    with pytest.raises(TrackingManifestError, match="publishedAt"):
        serialize_manifest(entries)


def test_deserialize_manifest_rejects_an_unrecognized_activity_state():
    """A stored activityState outside the canonical {Unknown, Hot, Warm, Cold} set
    (video_master.VALID_ACTIVITY_STATES) is rejected -- reusing that same
    canonical set rather than inventing a separate manifest-only enum."""
    table = pa.table(
        {
            "videoId": pa.array(["v1"], type=pa.string()),
            "creatorId": pa.array(["c1"], type=pa.string()),
            "active": pa.array([True], type=pa.bool_()),
            "discoveredAt": pa.array([None], type=pa.string()),
            "publishedAt": pa.array(["2026-08-01T00:00:00Z"], type=pa.string()),
            "activityState": pa.array(["Sizzling"], type=pa.string()),
        }
    )
    output = io.BytesIO()
    import pyarrow.parquet as parquet

    parquet.write_table(table, output)

    with pytest.raises(TrackingManifestError, match="activityState"):
        deserialize_manifest(output.getvalue())
