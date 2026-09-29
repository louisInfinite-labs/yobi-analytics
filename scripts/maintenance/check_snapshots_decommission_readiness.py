"""Read-only decommission-readiness checkpoint for YobiSnapshots/YobiRunSummaries
(AWS Cost Recovery, third pass, Scope G).

This is step 1 of the "controlled decommission mechanism" the task requires --
NOT a decommission action itself. This script never writes, deletes, or
modifies anything; it only reports evidence an operator needs to decide
whether decommissioning is safe.

WHY THIS SCRIPT EXISTS INSTEAD OF A DECOMMISSION SCRIPT: a full code/IaC
dependency audit (this pass) found a REAL remaining live dependency:

    GET /videos/{videoId}/growth (terraform/api_gateway.tf, enabled route)
      -> api.api_handler._handle_get_video_growth
      -> api.read_api.get_video_growth / _compute_growth_results
      -> stores.dynamodb_store.get_snapshot  (reads YobiSnapshots)

This is a real, routed, on-demand public API endpoint -- not a scheduled
batch job, so it has no EventBridge schedule to point to, but it is
absolutely part of the production-intended path (unlike collection.main.main(),
which has no schedule AND no route). Decommissioning YobiSnapshots today would
turn every call to this endpoint into a hard failure (get_snapshot's own
ClientError handling raises SnapshotStoreError once the table itself is gone,
not the graceful "pending"/"not_available" classification analytics.
view_growth_analytics.calculate_growth already returns for a merely-stale-but-
still-present table).

Separately: NOTHING writes new rows to YobiSnapshots/YobiRunSummaries on any
currently-scheduled production path. The only writer is collection.main.main(),
which terraform/eventbridge.tf confirms has no schedule at all (only
run_discovery, the lighter mode, is scheduled) -- so this data is frozen at
whatever the last manual/legacy run (or the one-time scripts/backfill/
backfill_history_parquet.py migration) left it at. That is exactly why this
script's own freshness check below matters: it turns "we believe nothing
writes here anymore" into a directly observable, dated fact.

END STATE (once a future pass confirms get_video_growth has been migrated off
Snapshots, or product/ops decides to retire that endpoint): raw history source
of truth = S3 (already true for the daily 1d/7d/30d ranking path); legacy
DynamoDB snapshots = removable, at that point, after explicit operator
approval -- never as an automatic consequence of running this script.

Usage (requires AWS credentials with read access to both tables; never
requested or run during this pass, since this machine has no AWS access):
    .venv/Scripts/python.exe scripts/maintenance/check_snapshots_decommission_readiness.py
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

import boto3  # noqa: E402
from stores.dynamodb_store import RUN_SUMMARIES_TABLE, SNAPSHOTS_TABLE  # noqa: E402

# A COMPLETE run summary dated within this many days of "now" is treated as
# evidence something is still actively writing YobiSnapshots -- not proof by
# itself (a single manual/legacy main() invocation would also produce one),
# but strong enough that decommissioning should not proceed without an
# operator explicitly explaining why a recent write exists.
RECENT_WRITE_THRESHOLD_DAYS = 7


def main() -> int:
    print("=== YobiSnapshots/YobiRunSummaries decommission-readiness checkpoint ===")
    print("(read-only -- this script never writes, deletes, or modifies anything)\n")

    resource = boto3.resource("dynamodb")
    run_summaries = resource.Table(RUN_SUMMARIES_TABLE)

    print(f"Scanning {RUN_SUMMARIES_TABLE} (small: one row per collection date)...")
    items: list[dict] = []
    response = run_summaries.scan()
    items.extend(response.get("Items", []))
    while "LastEvaluatedKey" in response:
        response = run_summaries.scan(ExclusiveStartKey=response["LastEvaluatedKey"])
        items.extend(response.get("Items", []))

    complete_dates = sorted(
        (date.fromisoformat(item["snapshotDate"]) for item in items if item.get("status") == "COMPLETE"),
        reverse=True,
    )

    if not complete_dates:
        print(f"No COMPLETE row found in {RUN_SUMMARIES_TABLE} at all.")
        most_recent = None
    else:
        most_recent = complete_dates[0]
        age_days = (date.today() - most_recent).days
        print(f"Most recent COMPLETE collection date: {most_recent.isoformat()} ({age_days} day(s) ago)")

    print()
    if most_recent is not None and (date.today() - most_recent).days <= RECENT_WRITE_THRESHOLD_DAYS:
        print(
            f"FINDING: A write within the last {RECENT_WRITE_THRESHOLD_DAYS} days exists. "
            "Something is still writing to this table -- do NOT proceed toward decommission "
            "without first identifying what (a manual main() run? an unexpected schedule?)."
        )
    else:
        print(
            "FINDING: No write within the recent-write threshold. This is consistent with "
            "collection.main.main() (the only writer) having no production schedule -- "
            "see terraform/eventbridge.tf. This alone does NOT mean decommission is safe: "
            "see this script's own module docstring for the live GET /videos/{videoId}/growth "
            "read dependency that must be resolved first (migrated off Snapshots, or "
            "explicitly retired) before YobiSnapshots itself can be considered for removal."
        )

    print(
        "\nThis script intentionally does not check GET /videos/{videoId}/growth's own "
        "real request volume (that needs API Gateway/CloudWatch access metrics, a separate, "
        "still-read-only check an operator can add here later) -- treat that endpoint as a "
        "live dependency until it is explicitly confirmed otherwise."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
