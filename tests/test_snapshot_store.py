import json
from datetime import date

import pytest

from snapshot_store import (
    Snapshot,
    SnapshotRunSummary,
    SnapshotStoreError,
    run_summary_path_for,
    save_daily_snapshot,
    save_run_summary,
    snapshot_path_for,
)


def _make_snapshot(**overrides):
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


def test_save_run_summary_writes_expected_content(tmp_path):
    """A run summary persists requested/collected counts and skipped video IDs as data."""
    summary = SnapshotRunSummary(
        snapshot_date="2026-08-29",
        requested_count=96262,
        collected_count=96200,
        skipped_video_ids=["v1", "v2"],
    )

    path = save_run_summary(summary, date(2026, 8, 29), tmp_path)

    assert path == tmp_path / "2026-08-29.summary.json"
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved == {
        "snapshotDate": "2026-08-29",
        "requestedCount": 96262,
        "collectedCount": 96200,
        "skippedCount": 2,
        "skippedVideoIds": ["v1", "v2"],
    }


def test_save_run_summary_refuses_to_overwrite_existing_day(tmp_path):
    """A second run-summary save for the same date raises instead of silently overwriting."""
    summary = SnapshotRunSummary(
        snapshot_date="2026-08-29", requested_count=1, collected_count=1, skipped_video_ids=[]
    )
    save_run_summary(summary, date(2026, 8, 29), tmp_path)

    with pytest.raises(FileExistsError):
        save_run_summary(summary, date(2026, 8, 29), tmp_path)


def test_run_summary_path_for_uses_iso_date(tmp_path):
    """The run-summary file path is named using the date's ISO format with a distinct suffix."""
    assert run_summary_path_for(date(2026, 1, 5), tmp_path) == tmp_path / "2026-01-05.summary.json"
