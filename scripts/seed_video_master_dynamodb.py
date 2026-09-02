"""One-off: copy the local Video Master's scheduler state into DynamoDB (Roadmap 2.3).

Run once before the first Lambda invocation on the DynamoDB backend, so that
run sees an already-populated Tracking Universe and performs normal
incremental discovery instead of a full from-scratch Initial Discovery across
every channel (which would burn far more YouTube quota and likely exceed
Lambda's timeout). This does not touch snapshots or run summaries — only
Video Master, since that's what drives the discovery/due-set decision.

Usage:
    .venv/Scripts/python.exe scripts/seed_video_master_dynamodb.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from dynamodb_store import VIDEO_MASTER_TABLE, upsert_videos  # noqa: E402
from video_master import load_videos  # noqa: E402

BATCH_SIZE = 500


def main() -> int:
    """Load the local Video Master and upsert every video into DynamoDB in bounded batches."""
    videos = load_videos()
    if not videos:
        print("Local Video Master is empty — nothing to seed.")
        return 0

    print(f"Seeding {len(videos)} video(s) from local video_master.json into {VIDEO_MASTER_TABLE}...")
    for start in range(0, len(videos), BATCH_SIZE):
        batch = videos[start : start + BATCH_SIZE]
        upsert_videos(batch)
        print(f"  {min(start + BATCH_SIZE, len(videos))}/{len(videos)}")

    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
