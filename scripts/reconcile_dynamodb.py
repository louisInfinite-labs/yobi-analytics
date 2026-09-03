"""Reconcile local JSON data against DynamoDB after the Roadmap 2.3 seed/migration.

Checks, for every local (snapshot, summary) day pair:
- The local run summary's requestedCount/collectedCount/skippedCount match
  the DynamoDB run summary for that date exactly.
- The number of DynamoDB snapshot items for that date matches the local
  summary's collectedCount (and the local snapshot file's own length).

Also reports the total Video Master item count in DynamoDB against the
local video_master.json count, and lists any DynamoDB-only snapshot dates
(e.g. a real Lambda-produced day with no local equivalent) without treating
them as a mismatch.

This is a read-only report — it does not write or fix anything. Sampling is
not used: every local day is checked in full, per Roadmap 2.3.1's
"sampling alone is insufficient for final approval."

Usage:
    .venv/Scripts/python.exe scripts/reconcile_dynamodb.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import boto3  # noqa: E402
from dynamodb_store import RUN_SUMMARIES_TABLE, SNAPSHOTS_TABLE, VIDEO_MASTER_TABLE  # noqa: E402
from snapshot_store import DEFAULT_SNAPSHOTS_DIR  # noqa: E402
from video_master import DEFAULT_VIDEO_MASTER_PATH, load_videos  # noqa: E402


def _local_days() -> list[str]:
    """Return the sorted dates with both a local snapshot file and a matching summary file."""
    return sorted(
        p.stem
        for p in DEFAULT_SNAPSHOTS_DIR.glob("*.json")
        if not p.name.endswith(".summary.json") and (DEFAULT_SNAPSHOTS_DIR / f"{p.stem}.summary.json").exists()
    )


def _dynamo_snapshot_count(table, snapshot_date: str) -> int:
    """Count DynamoDB YobiSnapshots items for one date via a filtered Scan (no GSI yet)."""
    count = 0
    scan_kwargs = {
        "FilterExpression": "snapshotDate = :d",
        "ExpressionAttributeValues": {":d": snapshot_date},
        "Select": "COUNT",
    }
    while True:
        response = table.scan(**scan_kwargs)
        count += response["Count"]
        if "LastEvaluatedKey" not in response:
            return count
        scan_kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]


def _dynamo_full_count(table) -> int:
    """Return a table's true total item count via a paginated COUNT-only Scan.

    A single Table.scan(Select="COUNT") call only counts one page (up to 1MB
    or 1000 items) — this must loop over LastEvaluatedKey for a table the
    size of YobiVideoMaster (126k+ items) or it silently undercounts.
    """
    count = 0
    scan_kwargs = {"Select": "COUNT"}
    while True:
        response = table.scan(**scan_kwargs)
        count += response["Count"]
        if "LastEvaluatedKey" not in response:
            return count
        scan_kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]


def _all_dynamo_snapshot_dates(table) -> set[str]:
    """Return every distinct snapshotDate present in YobiSnapshots (full scan, projection only)."""
    dates: set[str] = set()
    scan_kwargs = {"ProjectionExpression": "snapshotDate"}
    while True:
        response = table.scan(**scan_kwargs)
        dates.update(item["snapshotDate"] for item in response["Items"])
        if "LastEvaluatedKey" not in response:
            return dates
        scan_kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]


def main() -> int:
    """Run the full reconciliation and print a pass/fail report."""
    resource = boto3.resource("dynamodb")
    video_master_table = resource.Table(VIDEO_MASTER_TABLE)
    snapshots_table = resource.Table(SNAPSHOTS_TABLE)
    run_summaries_table = resource.Table(RUN_SUMMARIES_TABLE)

    problems: list[str] = []

    # --- Video Master -----------------------------------------------------
    local_video_count = len(load_videos(DEFAULT_VIDEO_MASTER_PATH))
    dynamo_video_count = _dynamo_full_count(video_master_table)
    print(f"Video Master: local={local_video_count}, DynamoDB={dynamo_video_count}")
    if dynamo_video_count < local_video_count:
        problems.append(
            f"Video Master: DynamoDB has fewer items ({dynamo_video_count}) than local ({local_video_count})"
        )
    elif dynamo_video_count > local_video_count:
        print(
            f"  Note: DynamoDB has {dynamo_video_count - local_video_count} more video(s) than the local "
            "snapshot of video_master.json — expected if a real collection run has happened in DynamoDB "
            "since the local file was last written (new discoveries)."
        )

    # --- Per-day snapshots + run summaries ---------------------------------
    local_dates = _local_days()
    for snapshot_date in local_dates:
        local_summary = json.loads((DEFAULT_SNAPSHOTS_DIR / f"{snapshot_date}.summary.json").read_text(encoding="utf-8"))
        local_snapshot_count = len(json.loads((DEFAULT_SNAPSHOTS_DIR / f"{snapshot_date}.json").read_text(encoding="utf-8")))

        dynamo_summary_item = run_summaries_table.get_item(Key={"snapshotDate": snapshot_date}).get("Item")
        if dynamo_summary_item is None:
            problems.append(f"{snapshot_date}: no run summary found in DynamoDB")
            continue

        for field, local_key in (
            ("requestedCount", "requestedCount"),
            ("collectedCount", "collectedCount"),
            ("skippedCount", "skippedCount"),
        ):
            if int(dynamo_summary_item[field]) != local_summary[local_key]:
                problems.append(
                    f"{snapshot_date}: run summary {field} mismatch — "
                    f"local={local_summary[local_key]}, DynamoDB={int(dynamo_summary_item[field])}"
                )

        dynamo_snapshot_count = _dynamo_snapshot_count(snapshots_table, snapshot_date)
        print(
            f"{snapshot_date}: local snapshot file={local_snapshot_count}, "
            f"local summary.collectedCount={local_summary['collectedCount']}, "
            f"DynamoDB snapshot items={dynamo_snapshot_count}"
        )
        if dynamo_snapshot_count != local_summary["collectedCount"]:
            problems.append(
                f"{snapshot_date}: DynamoDB snapshot item count ({dynamo_snapshot_count}) != "
                f"local summary collectedCount ({local_summary['collectedCount']})"
            )
        if dynamo_snapshot_count != local_snapshot_count:
            problems.append(
                f"{snapshot_date}: DynamoDB snapshot item count ({dynamo_snapshot_count}) != "
                f"local snapshot file length ({local_snapshot_count})"
            )

    # --- DynamoDB-only dates (e.g. a real Lambda run with no local file) ---
    dynamo_only_dates = _all_dynamo_snapshot_dates(snapshots_table) - set(local_dates)
    if dynamo_only_dates:
        print(f"DynamoDB-only snapshot date(s) (no local file, not a mismatch): {sorted(dynamo_only_dates)}")

    print()
    if problems:
        print(f"RECONCILIATION FAILED: {len(problems)} problem(s):")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    print("RECONCILIATION PASSED: every local day matches DynamoDB exactly.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
