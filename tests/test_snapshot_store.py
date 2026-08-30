import json
from datetime import date

import pytest

from snapshot_store import Snapshot, save_daily_snapshot, snapshot_path_for


def test_save_daily_snapshot_writes_expected_content(tmp_path):
    """Snapshots are written to a file named after the snapshot date."""
    snapshots = [Snapshot(video_id="v1", observed_at="2026-08-29T00:00:05+00:00", view_count=10230)]

    path = save_daily_snapshot(snapshots, date(2026, 8, 29), tmp_path)

    assert path == tmp_path / "2026-08-29.json"
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved == [{"videoId": "v1", "observedAt": "2026-08-29T00:00:05+00:00", "viewCount": 10230}]


def test_save_daily_snapshot_refuses_to_overwrite_existing_day(tmp_path):
    """A second save for the same date raises instead of silently overwriting."""
    snapshots = [Snapshot(video_id="v1", observed_at="2026-08-29T00:00:05+00:00", view_count=10230)]
    save_daily_snapshot(snapshots, date(2026, 8, 29), tmp_path)

    with pytest.raises(FileExistsError):
        save_daily_snapshot(snapshots, date(2026, 8, 29), tmp_path)


def test_snapshot_path_for_uses_iso_date(tmp_path):
    """The snapshot file path is named using the date's ISO format."""
    assert snapshot_path_for(date(2026, 1, 5), tmp_path) == tmp_path / "2026-01-05.json"
