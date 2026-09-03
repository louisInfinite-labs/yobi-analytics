import json
from datetime import date

import pytest

from snapshot_store import (
    SkippedVideo,
    Snapshot,
    SnapshotRunSummary,
    SnapshotStoreError,
    get_snapshot,
    load_snapshots_for_date,
    run_summary_path_for,
    save_daily_collection,
    save_daily_snapshot,
    save_run_summary,
    snapshot_path_for,
)


def _make_snapshot(**overrides):
    """Build a minimal valid Snapshot for a test, overriding only the given fields."""
    fields = {
        "snapshot_date": "2026-08-29",
        "observed_at": "2026-08-29T00:00:05+00:00",
        "creator_id": "aizawa_ema",
        "video_id": "v1",
        "title": "藍沢エマ Test Video",
        "published_at": "2026-08-25T12:00:00Z",
        "view_count": 10230,
        "organization": "vspo",
    }
    fields.update(overrides)
    return Snapshot(**fields)


def test_save_daily_snapshot_writes_expected_content(tmp_path):
    """Snapshots are written to a file named after the snapshot date, with every field."""
    snapshots = [_make_snapshot()]

    path = save_daily_snapshot(snapshots, date(2026, 8, 29), tmp_path)

    assert path == tmp_path / "2026-08-29.json"
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved == [
        {
            "snapshotDate": "2026-08-29",
            "observedAt": "2026-08-29T00:00:05+00:00",
            "creatorId": "aizawa_ema",
            "videoId": "v1",
            "title": "藍沢エマ Test Video",
            "publishedAt": "2026-08-25T12:00:00Z",
            "viewCount": 10230,
            "organization": "vspo",
        }
    ]


def test_save_daily_snapshot_refuses_to_overwrite_existing_day(tmp_path):
    """A second save for the same date raises instead of silently overwriting."""
    snapshots = [_make_snapshot()]
    save_daily_snapshot(snapshots, date(2026, 8, 29), tmp_path)

    with pytest.raises(FileExistsError):
        save_daily_snapshot(snapshots, date(2026, 8, 29), tmp_path)


def test_save_daily_snapshot_rejects_a_snapshot_dated_for_a_different_day(tmp_path):
    """A Snapshot whose own snapshotDate disagrees with the file's date is rejected,
    rather than silently written into the wrong day's file."""
    snapshots = [_make_snapshot(snapshot_date="2026-08-28")]

    with pytest.raises(SnapshotStoreError, match="2026-08-29"):
        save_daily_snapshot(snapshots, date(2026, 8, 29), tmp_path)


def test_snapshot_path_for_uses_iso_date(tmp_path):
    """The snapshot file path is named using the date's ISO format."""
    assert snapshot_path_for(date(2026, 1, 5), tmp_path) == tmp_path / "2026-01-05.json"


def _make_run_summary(**overrides):
    """Build a minimal valid SnapshotRunSummary for a test, overriding only the given fields."""
    fields = {
        "snapshot_date": "2026-08-29",
        "requested_count": 1,
        "collected_count": 1,
        "skipped": [],
    }
    fields.update(overrides)
    return SnapshotRunSummary(**fields)


def test_save_run_summary_writes_expected_content(tmp_path):
    """A run summary persists requested/collected counts and each skipped video's reason as data."""
    summary = SnapshotRunSummary(
        snapshot_date="2026-08-29",
        requested_count=96262,
        collected_count=96200,
        skipped=[
            SkippedVideo(video_id="v1", reason="YouTube API error: quota exceeded"),
            SkippedVideo(video_id="v2", reason="Malformed video item, missing field: 'statistics'"),
        ],
    )

    path = save_run_summary(summary, date(2026, 8, 29), tmp_path)

    assert path == tmp_path / "2026-08-29.summary.json"
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved == {
        "snapshotDate": "2026-08-29",
        "requestedCount": 96262,
        "collectedCount": 96200,
        "skippedCount": 2,
        "skipped": [
            {"videoId": "v1", "reason": "YouTube API error: quota exceeded"},
            {"videoId": "v2", "reason": "Malformed video item, missing field: 'statistics'"},
        ],
    }


def test_save_run_summary_refuses_to_overwrite_existing_day(tmp_path):
    """A second run-summary save for the same date raises instead of silently overwriting."""
    summary = _make_run_summary()
    save_run_summary(summary, date(2026, 8, 29), tmp_path)

    with pytest.raises(FileExistsError):
        save_run_summary(summary, date(2026, 8, 29), tmp_path)


def test_save_run_summary_rejects_a_summary_dated_for_a_different_day(tmp_path):
    """A SnapshotRunSummary whose own snapshotDate disagrees with the file's date is rejected,
    rather than silently written into the wrong day's file."""
    summary = _make_run_summary(snapshot_date="2026-08-28")

    with pytest.raises(SnapshotStoreError, match="2026-08-29"):
        save_run_summary(summary, date(2026, 8, 29), tmp_path)


def test_run_summary_path_for_uses_iso_date(tmp_path):
    """The run-summary file path is named using the date's ISO format with a distinct suffix."""
    assert run_summary_path_for(date(2026, 1, 5), tmp_path) == tmp_path / "2026-01-05.summary.json"


def test_save_daily_collection_writes_both_files(tmp_path):
    """save_daily_collection writes the snapshot and its run summary together."""
    snapshots = [_make_snapshot()]
    summary = _make_run_summary()

    snapshot_path, summary_path = save_daily_collection(snapshots, summary, date(2026, 8, 29), tmp_path)

    assert snapshot_path == tmp_path / "2026-08-29.json"
    assert summary_path == tmp_path / "2026-08-29.summary.json"
    assert snapshot_path.exists()
    assert summary_path.exists()


def test_save_daily_collection_rejects_duplicate_video_id(tmp_path):
    """Two snapshots for the same videoId would silently collapse in the
    file (or drift out of sync with a backend that keys on it) — matches
    dynamodb_store.py's equivalent check, now shared via validate_daily_collection."""
    snapshots = [_make_snapshot(video_id="v1"), _make_snapshot(video_id="v1")]
    summary = _make_run_summary(collected_count=2)

    with pytest.raises(SnapshotStoreError):
        save_daily_collection(snapshots, summary, date(2026, 8, 29), tmp_path)

    assert not (tmp_path / "2026-08-29.json").exists()


def test_save_daily_collection_rejects_collected_count_mismatch(tmp_path):
    """summary.collectedCount must match the actual number of snapshots provided."""
    summary = _make_run_summary(collected_count=2)

    with pytest.raises(SnapshotStoreError):
        save_daily_collection([_make_snapshot(video_id="v1")], summary, date(2026, 8, 29), tmp_path)


def test_save_daily_collection_rejects_requested_count_arithmetic_mismatch(tmp_path):
    """requestedCount must equal collectedCount + len(skipped)."""
    summary = SnapshotRunSummary(snapshot_date="2026-08-29", requested_count=5, collected_count=1, skipped=[])

    with pytest.raises(SnapshotStoreError):
        save_daily_collection([_make_snapshot(video_id="v1")], summary, date(2026, 8, 29), tmp_path)


def test_save_daily_collection_rejects_duplicate_skipped_video_id(tmp_path):
    summary = SnapshotRunSummary(
        snapshot_date="2026-08-29",
        requested_count=3,
        collected_count=1,
        skipped=[SkippedVideo(video_id="v2", reason="a"), SkippedVideo(video_id="v2", reason="b")],
    )

    with pytest.raises(SnapshotStoreError):
        save_daily_collection([_make_snapshot(video_id="v1")], summary, date(2026, 8, 29), tmp_path)


def test_save_daily_collection_rejects_video_id_both_collected_and_skipped(tmp_path):
    """A videoId reported as both collected and skipped would let the
    persisted summary contradict itself about that video's outcome."""
    summary = SnapshotRunSummary(
        snapshot_date="2026-08-29",
        requested_count=2,
        collected_count=1,
        skipped=[SkippedVideo(video_id="v1", reason="malformed item")],
    )

    with pytest.raises(SnapshotStoreError):
        save_daily_collection([_make_snapshot(video_id="v1")], summary, date(2026, 8, 29), tmp_path)


def test_save_daily_collection_rolls_back_snapshot_if_summary_write_fails(tmp_path):
    """If the summary write fails after the snapshot write succeeded, the snapshot is
    deleted too, so a retry isn't permanently blocked by a stray leftover file."""
    snapshots = [_make_snapshot()]
    mismatched_summary = _make_run_summary(snapshot_date="2026-08-28")

    with pytest.raises(SnapshotStoreError):
        save_daily_collection(snapshots, mismatched_summary, date(2026, 8, 29), tmp_path)

    assert not (tmp_path / "2026-08-29.json").exists()
    assert not (tmp_path / "2026-08-29.summary.json").exists()


# --- load_snapshots_for_date / get_snapshot -------------------------------


def test_load_snapshots_for_date_returns_empty_list_when_file_missing(tmp_path):
    """A date with no snapshot file yet behaves like an empty day, not an error."""
    assert load_snapshots_for_date(date(2026, 8, 29), tmp_path) == []


def test_load_snapshots_for_date_returns_every_recorded_snapshot(tmp_path):
    """Every video recorded for a date is returned, not just the first one."""
    snapshots = [_make_snapshot(video_id="v1"), _make_snapshot(video_id="v2")]
    save_daily_snapshot(snapshots, date(2026, 8, 29), tmp_path)

    loaded = load_snapshots_for_date(date(2026, 8, 29), tmp_path)

    assert {s.video_id for s in loaded} == {"v1", "v2"}


def test_get_snapshot_returns_none_when_date_has_no_file(tmp_path):
    """A date with no snapshot file at all returns None, not an error."""
    assert get_snapshot("v1", date(2026, 8, 29), tmp_path) is None


def test_get_snapshot_returns_none_when_video_not_in_that_days_file(tmp_path):
    """A missing video within an existing day's file is None, not KeyError —
    the caller (Roadmap 3.1) decides what that means (pending vs. not available)."""
    save_daily_snapshot([_make_snapshot(video_id="v1")], date(2026, 8, 29), tmp_path)

    assert get_snapshot("v2", date(2026, 8, 29), tmp_path) is None


def test_get_snapshot_returns_the_matching_video(tmp_path):
    """Only the requested video's snapshot is returned from a multi-video day."""
    snapshots = [_make_snapshot(video_id="v1", view_count=100), _make_snapshot(video_id="v2", view_count=200)]
    save_daily_snapshot(snapshots, date(2026, 8, 29), tmp_path)

    found = get_snapshot("v2", date(2026, 8, 29), tmp_path)

    assert found is not None
    assert found.video_id == "v2"
    assert found.view_count == 200
