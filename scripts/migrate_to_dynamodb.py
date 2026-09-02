"""Formal local-to-DynamoDB migration tool (Roadmap 2.3.1).

The formal counterpart to the ad-hoc one-off scripts already used for this
project's initial DynamoDB bootstrap (seed_video_master_dynamodb.py,
seed_snapshots_dynamodb.py). Adds what those didn't have: validation,
--dry-run, checksum-based idempotent replay, hard conflict detection, and a
cutover manifest. Safe to re-run — already-migrated units are detected by
checksum and skipped rather than re-written.

Scope note: Snapshots and run summaries are immutable per-day facts, so they
get full idempotent-or-conflict treatment (a mismatched checksum against an
already-present day is a hard error, never silently overwritten). Video
Master is a continuously mutating *current-state* store by design (Roadmap
1.5) — a byte-for-byte "identical or conflict" check doesn't fit data that's
expected to keep changing as real collection runs happen, so Video Master
gets validation + upsert, not checksum conflict detection.

Usage:
    .venv/Scripts/python.exe scripts/migrate_to_dynamodb.py --dry-run
    .venv/Scripts/python.exe scripts/migrate_to_dynamodb.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import boto3  # noqa: E402
from dynamodb_store import (  # noqa: E402
    RUN_SUMMARIES_TABLE,
    SNAPSHOTS_TABLE,
    VIDEO_MASTER_TABLE,
    save_daily_collection,
    upsert_videos,
)
from snapshot_store import (  # noqa: E402
    DEFAULT_SNAPSHOTS_DIR,
    SkippedVideo,
    Snapshot,
    SnapshotRunSummary,
)
from snapshot_store import _summary_to_raw  # noqa: E402
from snapshot_store import _to_raw as _snapshot_to_raw  # noqa: E402
from video_master import DEFAULT_VIDEO_MASTER_PATH  # noqa: E402
from video_master import load_videos as load_local_videos  # noqa: E402
from video_master import _to_raw as _video_to_raw  # noqa: E402

SCHEMA_VERSION = "1.0"
MANIFEST_PATH = Path(__file__).parent.parent / "build" / "dynamodb_cutover_manifest.json"


def _checksum(records: list[dict]) -> str:
    """Deterministic SHA-256 over a list of records, sorted by videoId for stable ordering."""
    canonical = json.dumps(sorted(records, key=lambda r: r["videoId"]), sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _decimals_to_plain(item: dict[str, Any]) -> dict[str, Any]:
    """Convert every Decimal in a DynamoDB item to int (whole numbers) or float, for JSON checksumming."""
    plain = {}
    for key, value in item.items():
        if isinstance(value, Decimal):
            plain[key] = int(value) if value == value.to_integral_value() else float(value)
        elif isinstance(value, list):
            plain[key] = [_decimals_to_plain(v) if isinstance(v, dict) else v for v in value]
        else:
            plain[key] = value
    return plain


# --- Validation ------------------------------------------------------------


def _validate_video_master(videos: list) -> list[str]:
    """Roadmap 2.3.1: required IDs, non-negative counts, unique keys."""
    errors = []
    seen_ids: set[str] = set()
    for video in videos:
        if not video.video_id or not video.creator_id:
            errors.append(f"Video Master record missing videoId/creatorId: {video!r}")
        if video.video_id in seen_ids:
            errors.append(f"Video Master: duplicate videoId {video.video_id!r}")
        seen_ids.add(video.video_id)
        if video.snapshot_count < 0:
            errors.append(f"{video.video_id}: negative snapshotCount {video.snapshot_count}")
        if video.quiet_streak < 0:
            errors.append(f"{video.video_id}: negative quietStreak {video.quiet_streak}")
        if video.last_view_count is not None and video.last_view_count < 0:
            errors.append(f"{video.video_id}: negative lastViewCount {video.last_view_count}")
    return errors


def _validate_day(
    snapshot_date_str: str, snapshots: list[Snapshot], summary: SnapshotRunSummary, known_video_ids: set[str]
) -> list[str]:
    """Roadmap 2.3.1: unique (videoId, snapshotDate) keys, non-negative counts,
    snapshot/summary pairing, referential consistency with Video Master."""
    errors = []
    seen_keys: set[tuple[str, str]] = set()
    for snapshot in snapshots:
        key = (snapshot.video_id, snapshot.snapshot_date)
        if key in seen_keys:
            errors.append(f"{snapshot_date_str}: duplicate (videoId, snapshotDate) key {key}")
        seen_keys.add(key)
        if snapshot.snapshot_date != snapshot_date_str:
            errors.append(
                f"{snapshot_date_str}: snapshot for {snapshot.video_id} has snapshotDate "
                f"{snapshot.snapshot_date!r}, expected {snapshot_date_str!r}"
            )
        if snapshot.view_count < 0:
            errors.append(f"{snapshot_date_str}: {snapshot.video_id} has negative viewCount {snapshot.view_count}")
        if not snapshot.video_id or not snapshot.creator_id:
            errors.append(f"{snapshot_date_str}: a snapshot is missing videoId/creatorId")
        if snapshot.video_id not in known_video_ids:
            errors.append(
                f"{snapshot_date_str}: {snapshot.video_id} has a snapshot but no Video Master record"
            )

    if summary.snapshot_date != snapshot_date_str:
        errors.append(
            f"{snapshot_date_str}: run summary snapshotDate {summary.snapshot_date!r} != {snapshot_date_str!r}"
        )
    if summary.collected_count != len(snapshots):
        errors.append(
            f"{snapshot_date_str}: summary.collectedCount ({summary.collected_count}) != "
            f"snapshot file length ({len(snapshots)})"
        )
    if summary.requested_count != summary.collected_count + len(summary.skipped):
        errors.append(
            f"{snapshot_date_str}: summary.requestedCount ({summary.requested_count}) != "
            f"collectedCount + len(skipped) ({summary.collected_count + len(summary.skipped)})"
        )
    return errors


def _load_local_day(snapshot_date_str: str) -> tuple[list[Snapshot], SnapshotRunSummary]:
    raw_snapshots = json.loads((DEFAULT_SNAPSHOTS_DIR / f"{snapshot_date_str}.json").read_text(encoding="utf-8"))
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
    raw_summary = json.loads((DEFAULT_SNAPSHOTS_DIR / f"{snapshot_date_str}.summary.json").read_text(encoding="utf-8"))
    summary = SnapshotRunSummary(
        snapshot_date=raw_summary["snapshotDate"],
        requested_count=raw_summary["requestedCount"],
        collected_count=raw_summary["collectedCount"],
        skipped=[SkippedVideo(video_id=s["videoId"], reason=s["reason"]) for s in raw_summary.get("skipped", [])],
    )
    return snapshots, summary


def _local_days() -> list[str]:
    return sorted(
        p.stem
        for p in DEFAULT_SNAPSHOTS_DIR.glob("*.json")
        if not p.name.endswith(".summary.json") and (DEFAULT_SNAPSHOTS_DIR / f"{p.stem}.summary.json").exists()
    )


def _existing_dynamo_day(snapshot_date_str: str) -> list[dict] | None:
    """Return this date's existing DynamoDB snapshot items (plain, Decimal-free), or None if absent."""
    table = boto3.resource("dynamodb").Table(SNAPSHOTS_TABLE)
    items: list[dict] = []
    scan_kwargs = {
        "FilterExpression": "snapshotDate = :d",
        "ExpressionAttributeValues": {":d": snapshot_date_str},
    }
    while True:
        response = table.scan(**scan_kwargs)
        items.extend(_decimals_to_plain(item) for item in response["Items"])
        if "LastEvaluatedKey" not in response:
            break
        scan_kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]
    return items or None


def main() -> int:
    """Validate, plan (and optionally execute) the local-to-DynamoDB migration."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Report the plan without writing anything.")
    args = parser.parse_args()

    run_id = datetime.now(timezone.utc).strftime("migration-%Y%m%dT%H%M%SZ")
    print(f"Migration run: {run_id} ({'DRY RUN' if args.dry_run else 'LIVE'})")

    all_errors: list[str] = []
    manifest: dict[str, Any] = {
        "migrationRunId": run_id,
        "schemaVersion": SCHEMA_VERSION,
        "destination": {
            "videoMasterTable": VIDEO_MASTER_TABLE,
            "snapshotsTable": SNAPSHOTS_TABLE,
            "runSummariesTable": RUN_SUMMARIES_TABLE,
            "region": boto3.Session().region_name,
        },
        "days": {},
    }

    # --- Video Master -------------------------------------------------
    local_videos = load_local_videos(DEFAULT_VIDEO_MASTER_PATH)
    video_errors = _validate_video_master(local_videos)
    all_errors.extend(video_errors)
    known_video_ids = {video.video_id for video in local_videos}
    video_checksum = _checksum([_video_to_raw(video) for video in local_videos])
    print(f"Video Master: {len(local_videos)} record(s), {len(video_errors)} validation error(s), "
          f"checksum={video_checksum[:12]}...")
    manifest["videoMaster"] = {
        "sourceRecordCount": len(local_videos),
        "sourceChecksum": video_checksum,
        "validationErrors": video_errors,
        "action": "upsert (Video Master is mutable current-state, not conflict-checked)",
    }

    # --- Pass 1: validate every day and plan its action — no writes here ---
    local_dates = _local_days()
    if not local_dates:
        print("No local (snapshot, summary) day pairs found.")
    earliest_date, latest_date = (local_dates[0], local_dates[-1]) if local_dates else (None, None)

    conflicts: list[str] = []
    day_plans: dict[str, tuple[list[Snapshot], SnapshotRunSummary, str]] = {}
    for snapshot_date_str in local_dates:
        snapshots, summary = _load_local_day(snapshot_date_str)
        day_errors = _validate_day(snapshot_date_str, snapshots, summary, known_video_ids)
        all_errors.extend(day_errors)

        source_records = [_snapshot_to_raw(s) for s in snapshots]
        source_checksum = _checksum(source_records)

        existing = _existing_dynamo_day(snapshot_date_str)
        if existing is None:
            action = "write"
        else:
            dest_checksum = _checksum(existing)
            if dest_checksum == source_checksum:
                action = "skip (already migrated, checksum matches)"
            else:
                action = "CONFLICT (destination has different data for this date)"
                conflicts.append(snapshot_date_str)

        print(
            f"{snapshot_date_str}: {len(snapshots)} snapshot(s), {len(day_errors)} validation error(s), "
            f"checksum={source_checksum[:12]}..., action={action}"
        )
        manifest["days"][snapshot_date_str] = {
            "sourceSnapshotCount": len(snapshots),
            "sourceChecksum": source_checksum,
            "validationErrors": day_errors,
            "action": action,
        }
        day_plans[snapshot_date_str] = (snapshots, summary, action)

    # --- Pass 2: only write anything once every day above validated clean ---
    # Gating writes on `all_errors`/`conflicts` (accumulated across *all* days
    # and Video Master), not on one day's own errors, is what keeps "nothing
    # destructive was done" on failure actually true: a later day failing
    # validation must not leave an earlier day's write already committed.
    if not args.dry_run and not all_errors and not conflicts:
        upsert_videos(local_videos)
        manifest["videoMaster"]["action"] = "upserted"

        for snapshot_date_str, (snapshots, summary, action) in day_plans.items():
            if action != "write":
                continue
            try:
                save_daily_collection(snapshots, summary, date.fromisoformat(snapshot_date_str))
                manifest["days"][snapshot_date_str]["action"] = "written"
            except FileExistsError:
                # Reserved by a concurrent run between our read and our write; treat as skip, not fatal.
                manifest["days"][snapshot_date_str]["action"] = "skip (reserved concurrently)"

    manifest["proposedNextCollectionDate"] = None
    if latest_date:
        manifest["proposedNextCollectionDate"] = (date.fromisoformat(latest_date) + timedelta(days=1)).isoformat()
    manifest["sourceDateRange"] = {"earliest": earliest_date, "latest": latest_date}
    manifest["verificationResult"] = "FAILED" if (all_errors or conflicts) else "PASSED"
    manifest["totalValidationErrors"] = len(all_errors)
    manifest["conflicts"] = conflicts

    print()
    print(f"Validation errors: {len(all_errors)}")
    print(f"Conflicts: {len(conflicts)}")
    print(f"Proposed next collection date (day after latest local date): {manifest['proposedNextCollectionDate']}")

    if not args.dry_run:
        MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
        MANIFEST_PATH.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print(f"Cutover manifest written to {MANIFEST_PATH}")

    if all_errors or conflicts:
        print("MIGRATION FAILED — see validation errors / conflicts above. Nothing destructive was done.")
        return 1

    print("MIGRATION PLAN VALID." if args.dry_run else "MIGRATION COMPLETE.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
