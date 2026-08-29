"""Daily Raw Snapshot storage: one JSON file per day, never overwriting prior days."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path

from json_store import JsonStoreError, write_json_list

DEFAULT_SNAPSHOTS_DIR = Path(__file__).parent / "snapshots"


class SnapshotStoreError(JsonStoreError):
    """Raised when a daily snapshot cannot be written."""


@dataclass(frozen=True)
class Snapshot:
    """A single video's raw public-statistics snapshot for one point in time."""

    video_id: str
    observed_at: str
    view_count: int


def snapshot_path_for(snapshot_date: date, directory: Path = DEFAULT_SNAPSHOTS_DIR) -> Path:
    """Return the snapshot file path for a given date."""
    return directory / f"{snapshot_date.isoformat()}.json"


def save_daily_snapshot(
    snapshots: list[Snapshot], snapshot_date: date, directory: Path = DEFAULT_SNAPSHOTS_DIR
) -> Path:
    """Write a day's raw snapshots to their own dated file, refusing to overwrite an existing one."""
    path = snapshot_path_for(snapshot_date, directory)
    if path.exists():
        raise FileExistsError(f"Snapshot for {snapshot_date.isoformat()} already exists at {path}")

    payload = [_to_raw(snapshot) for snapshot in snapshots]
    write_json_list(path, payload, store_name="Snapshot", error_class=SnapshotStoreError)
    return path


def _to_raw(snapshot: Snapshot) -> dict:
    """Convert a Snapshot instance into its JSON-serializable form."""
    return {
        "videoId": snapshot.video_id,
        "observedAt": snapshot.observed_at,
        "viewCount": snapshot.view_count,
    }
