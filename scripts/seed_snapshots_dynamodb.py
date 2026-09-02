"""One-off: copy already-collected local daily snapshots + run summaries into DynamoDB (Roadmap 2.3).

Migrates the historical days already sitting in src/snapshots/*.json so
they aren't thrown away once DynamoDB becomes the collector's storage
backend. Uses dynamodb_store.save_daily_collection for each day, so the
same exclusivity/rollback guarantees apply as a normal collection run would
get, and a day already present in DynamoDB is skipped rather than erroring
the whole run.

A local day is only migrated when both its snapshot file and its matching
`.summary.json` exist. This naturally excludes:
- 2026-08-29.json: pre-dates the 8-field snapshot format (no creatorId/
  title/publishedAt/organization) and was never given a summary file — kept
  locally only as a reference, never part of the tracked daily series.
- *.json.bak files: local backup artifacts, not a collected day (a `.bak`
  suffix means the glob for `*.json` never matches them in the first place).

Usage:
    .venv/Scripts/python.exe scripts/seed_snapshots_dynamodb.py
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from dynamodb_store import save_daily_collection  # noqa: E402
from snapshot_store import DEFAULT_SNAPSHOTS_DIR, SkippedVideo, Snapshot, SnapshotRunSummary  # noqa: E402


def _load_day(snapshot_date: str) -> tuple[list[Snapshot], SnapshotRunSummary]:
    """Load one local day's snapshot list and run summary into their dataclasses."""
    snapshot_path = DEFAULT_SNAPSHOTS_DIR / f"{snapshot_date}.json"
    summary_path = DEFAULT_SNAPSHOTS_DIR / f"{snapshot_date}.summary.json"

    raw_snapshots = json.loads(snapshot_path.read_text(encoding="utf-8"))
    snapshots = [
        Snapshot(
            snapshot_date=raw["snapshotDate"],
            observed_at=raw["observedAt"],
            creator_id=raw["creatorId"],
            video_id=raw["videoId"],
            title=raw["title"],
            published_at=raw["publishedAt"],
            view_count=raw["viewCount"],
            organization=raw["organization"],
        )
        for raw in raw_snapshots
    ]

    raw_summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary = SnapshotRunSummary(
        snapshot_date=raw_summary["snapshotDate"],
        requested_count=raw_summary["requestedCount"],
        collected_count=raw_summary["collectedCount"],
        skipped=[SkippedVideo(video_id=s["videoId"], reason=s["reason"]) for s in raw_summary.get("skipped", [])],
    )
    return snapshots, summary


def _migratable_dates() -> list[str]:
    """Return the sorted dates that have both a snapshot file and a matching summary file."""
    return sorted(
        p.stem
        for p in DEFAULT_SNAPSHOTS_DIR.glob("*.json")
        if not p.name.endswith(".summary.json") and (DEFAULT_SNAPSHOTS_DIR / f"{p.stem}.summary.json").exists()
    )


def main() -> int:
    """Seed every valid local (snapshot, summary) day pair into DynamoDB."""
    dates = _migratable_dates()
    if not dates:
        print("No local (snapshot, summary) pairs found — nothing to seed.")
        return 0

    for snapshot_date in dates:
        snapshots, summary = _load_day(snapshot_date)
        print(f"Seeding {snapshot_date}: {len(snapshots)} snapshot(s), {summary.collected_count} collected...")
        try:
            save_daily_collection(snapshots, summary, date.fromisoformat(snapshot_date))
        except FileExistsError:
            print(f"  {snapshot_date} already exists in DynamoDB, skipping.")
            continue
        print("  Done.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
