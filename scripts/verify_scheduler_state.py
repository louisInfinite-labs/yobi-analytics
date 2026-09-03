"""Spot-check Video Master's classification state against re-running the
current classify_after_observation on the actual snapshot history in
DynamoDB (Roadmap 2.3.1 step 6, scoped to what our 4-day snapshot window
can actually support).

Video Master keeps no history of its own prior scheduler state, so a true
full rebuild (verifying every transition a video ever went through) isn't
possible from only 4 collected days. What *is* verifiable without ambiguity:
a video whose Video Master record has snapshot_count == 2 has had exactly
two observations, ever. If both of those observations fall inside our known
DynamoDB snapshot window, we have its *complete* history and can deterministically
recompute what classify_after_observation should have produced — and check
it against what's actually stored.

This intentionally does not check videos with snapshot_count > 2: their full
history includes observations from before DynamoDB had any snapshot data
(local-only history never migrated), so a partial replay would not be a
meaningful comparison and could produce false mismatches.

Usage:
    .venv/Scripts/python.exe scripts/verify_scheduler_state.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import boto3  # noqa: E402
from boto3.dynamodb.conditions import Key  # noqa: E402
from dynamodb_store import SNAPSHOTS_TABLE, load_videos  # noqa: E402
from tracking_schedule import classify_after_observation  # noqa: E402


def main() -> int:
    """Recompute classify_after_observation for every fully-known 2-snapshot video and compare."""
    print("Loading Video Master from DynamoDB...")
    videos = load_videos()
    candidates = [video for video in videos if video.snapshot_count == 2]
    print(f"Video Master: {len(videos)} total, {len(candidates)} with snapshot_count == 2 (candidates)")

    table = boto3.resource("dynamodb").Table(SNAPSHOTS_TABLE)

    checked = 0
    skipped_incomplete_history = 0
    mismatches: list[str] = []

    for video in candidates:
        response = table.query(KeyConditionExpression=Key("videoId").eq(video.video_id))
        items = sorted(response["Items"], key=lambda item: item["snapshotDate"])

        if len(items) != 2:
            # This video's snapshot_count==2 history isn't fully covered by our
            # 4-day DynamoDB window (e.g. one or both observations predate it) —
            # not comparable, and not a mismatch.
            skipped_incomplete_history += 1
            continue

        checked += 1
        first, second = items
        result = classify_after_observation(
            current_state="Unknown",
            snapshot_count=1,
            quiet_streak=0,
            previous_view_count=int(first["viewCount"]),
            previous_checked_at=first["observedAt"],
            new_view_count=int(second["viewCount"]),
            observed_at=second["observedAt"],
        )

        recomputed_percent = None if result.percent_per_day is None else round(float(result.percent_per_day), 6)
        recomputed_avg = None if result.avg_views_per_day is None else round(float(result.avg_views_per_day), 6)
        stored_percent = None if video.last_percent_growth_per_day is None else round(video.last_percent_growth_per_day, 6)
        stored_avg = None if video.last_avg_views_per_day is None else round(video.last_avg_views_per_day, 6)

        if (
            result.activity_state != video.activity_state
            or result.reason != video.last_classification_reason
            or recomputed_percent != stored_percent
            or recomputed_avg != stored_avg
        ):
            mismatches.append(
                f"{video.video_id}: stored=(state={video.activity_state!r}, "
                f"reason={video.last_classification_reason!r}, pct={stored_percent!r}, avg={stored_avg!r}) "
                f"recomputed=(state={result.activity_state!r}, reason={result.reason!r}, "
                f"pct={recomputed_percent!r}, avg={recomputed_avg!r})"
            )

    print(f"Skipped (incomplete history in our 4-day window): {skipped_incomplete_history}")
    print(f"Checked (complete 2-observation history): {checked}")
    print()

    if mismatches:
        print(f"VERIFICATION FAILED: {len(mismatches)} mismatch(es):")
        for mismatch in mismatches[:20]:
            print(f"  - {mismatch}")
        if len(mismatches) > 20:
            print(f"  ... and {len(mismatches) - 20} more")
        return 1

    print(f"VERIFICATION PASSED: all {checked} fully-known videos match the current classification logic exactly.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
