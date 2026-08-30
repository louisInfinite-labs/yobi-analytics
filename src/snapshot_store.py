"""Daily Raw Snapshot storage: one JSON file per day, never overwriting prior days."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path

from json_store import DATA_DIR, JsonStoreError, write_json_list_exclusive, write_json_object_exclusive

# DATA_DIR defaults to this package's own directory locally, but is overridden
# to /tmp on Lambda, where the deployment package itself is read-only (see
# Roadmap 2.2 "Known Constraint"). /tmp is wiped on cold start, so this is not
# durable storage — that's Roadmap 2.3 (DynamoDB), not this module's job.
DEFAULT_SNAPSHOTS_DIR = DATA_DIR / "snapshots"


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
class SkippedVideo:
    """One video that was due for collection but could not be recorded, and why."""

    video_id: str
    reason: str


@dataclass(frozen=True)
class SnapshotRunSummary:
    """Completeness record for one day's collection run.

    Persisted alongside the snapshot data itself (Roadmap 1.6) so a video
    missing from a day's snapshot can be told apart from a video that simply
    wasn't due that day — a log line alone isn't queryable by future
    analytics, so completeness must live in stored data, not just stdout.
    Each skip carries its reason (e.g. a YouTube API failure vs. a malformed
    item) so it's checkable later without digging through console logs.
    """

    snapshot_date: str
    requested_count: int
    collected_count: int
    skipped: list[SkippedVideo]


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
    expected_date = snapshot_date.isoformat()
    if summary.snapshot_date != expected_date:
        raise SnapshotStoreError(
            f"Snapshot Run Summary snapshotDate {summary.snapshot_date!r} does not match the requested {expected_date}"
        )

    path = run_summary_path_for(snapshot_date, directory)
    try:
        write_json_object_exclusive(
            path, _summary_to_raw(summary), store_name="Snapshot Run Summary", error_class=SnapshotStoreError
        )
    except FileExistsError:
        raise FileExistsError(f"Snapshot run summary for {snapshot_date.isoformat()} already exists at {path}") from None
    return path


def save_daily_collection(
    snapshots: list[Snapshot],
    run_summary: SnapshotRunSummary,
    snapshot_date: date,
    directory: Path = DEFAULT_SNAPSHOTS_DIR,
) -> tuple[Path, Path]:
    """Write a day's snapshot and its run summary together as one recoverable pair.

    Both files use exclusive create, so if the summary write fails after the
    snapshot write succeeded, the snapshot is rolled back (deleted) before
    re-raising. Without this, a retry would find the snapshot already there
    and refuse to write it again, permanently blocking the summary from ever
    being saved for that day.
    """
    snapshot_path = save_daily_snapshot(snapshots, snapshot_date, directory)
    try:
        summary_path = save_run_summary(run_summary, snapshot_date, directory)
    except (FileExistsError, SnapshotStoreError):
        snapshot_path.unlink(missing_ok=True)
        raise
    return snapshot_path, summary_path


def _summary_to_raw(summary: SnapshotRunSummary) -> dict:
    """Convert a SnapshotRunSummary instance into its JSON-serializable form."""
    return {
        "snapshotDate": summary.snapshot_date,
        "requestedCount": summary.requested_count,
        "collectedCount": summary.collected_count,
        "skippedCount": len(summary.skipped),
        "skipped": [{"videoId": skip.video_id, "reason": skip.reason} for skip in summary.skipped],
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
