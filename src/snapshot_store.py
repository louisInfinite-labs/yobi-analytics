"""Daily Raw Snapshot storage: one JSON file per day, never overwriting prior days."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path

from json_store import JsonStoreError, write_json_list_exclusive, write_json_object_exclusive

DEFAULT_SNAPSHOTS_DIR = Path(__file__).parent / "snapshots"


class SnapshotStoreError(JsonStoreError):
    """Raised when a daily snapshot cannot be written."""


@dataclass(frozen=True)
class Snapshot:
    """A single video's raw public-statistics snapshot for one point in time.

    Carries creatorId/organization/title/publishedAt alongside the raw
    viewCount so each record is self-contained (Roadmap 1.6) — readable and
    migration-friendly without needing to cross-reference Video/Creator
    Master to make sense of a snapshot file on its own.
    """

    snapshot_date: str
    observed_at: str
    creator_id: str
    video_id: str
    title: str
    published_at: str
    view_count: int
    organization: str


@dataclass(frozen=True)
class SnapshotRunSummary:
    """Completeness record for one day's collection run.

    Persisted alongside the snapshot data itself (Roadmap 1.6) so a video
    missing from a day's snapshot can be told apart from a video that simply
    wasn't due that day — a log line alone isn't queryable by future
    analytics, so completeness must live in stored data, not just stdout.
    """

    snapshot_date: str
    requested_count: int
    collected_count: int
    skipped_video_ids: list[str]


def snapshot_path_for(snapshot_date: date, directory: Path = DEFAULT_SNAPSHOTS_DIR) -> Path:
    """Return the snapshot file path for a given date."""
    return directory / f"{snapshot_date.isoformat()}.json"


def run_summary_path_for(snapshot_date: date, directory: Path = DEFAULT_SNAPSHOTS_DIR) -> Path:
    """Return the run-summary file path for a given date."""
    return directory / f"{snapshot_date.isoformat()}.summary.json"


def save_daily_snapshot(
    snapshots: list[Snapshot], snapshot_date: date, directory: Path = DEFAULT_SNAPSHOTS_DIR
) -> Path:
    """Write a day's raw snapshots to their own dated file, refusing to overwrite an existing one.

    Creation is atomic (temp file + os.link) so a concurrent run can never
    race the exists-check and clobber an already-written snapshot.
    """
    expected_date = snapshot_date.isoformat()
    mismatched = [snapshot.video_id for snapshot in snapshots if snapshot.snapshot_date != expected_date]
    if mismatched:
        raise SnapshotStoreError(
            f"Snapshot(s) with snapshotDate not matching the requested {expected_date}: {mismatched}"
        )

    path = snapshot_path_for(snapshot_date, directory)
    payload = [_to_raw(snapshot) for snapshot in snapshots]
    try:
        write_json_list_exclusive(path, payload, store_name="Snapshot", error_class=SnapshotStoreError)
    except FileExistsError:
        raise FileExistsError(f"Snapshot for {snapshot_date.isoformat()} already exists at {path}") from None
    return path


def save_run_summary(
    summary: SnapshotRunSummary, snapshot_date: date, directory: Path = DEFAULT_SNAPSHOTS_DIR
) -> Path:
    """Write a day's collection-run completeness summary, refusing to overwrite an existing one."""
    path = run_summary_path_for(snapshot_date, directory)
    try:
        write_json_object_exclusive(
            path, _summary_to_raw(summary), store_name="Snapshot Run Summary", error_class=SnapshotStoreError
        )
    except FileExistsError:
        raise FileExistsError(f"Snapshot run summary for {snapshot_date.isoformat()} already exists at {path}") from None
    return path


def _summary_to_raw(summary: SnapshotRunSummary) -> dict:
    """Convert a SnapshotRunSummary instance into its JSON-serializable form."""
    return {
        "snapshotDate": summary.snapshot_date,
        "requestedCount": summary.requested_count,
        "collectedCount": summary.collected_count,
        "skippedCount": len(summary.skipped_video_ids),
        "skippedVideoIds": summary.skipped_video_ids,
    }


def _to_raw(snapshot: Snapshot) -> dict:
    """Convert a Snapshot instance into its JSON-serializable form."""
    return {
        "snapshotDate": snapshot.snapshot_date,
        "observedAt": snapshot.observed_at,
        "creatorId": snapshot.creator_id,
        "videoId": snapshot.video_id,
        "title": snapshot.title,
        "publishedAt": snapshot.published_at,
        "viewCount": snapshot.view_count,
        "organization": snapshot.organization,
    }
