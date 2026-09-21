"""Backfill the `topic` field on existing YobiVideoMaster records from their stored titles.

Classifies with tracking.video_topics.classify_video_topic only: no YouTube
calls, no quota. Writes are a targeted UpdateItem on `topic`, so no other Video
Master field is touched. Run it outside the daily collection window: the history
worker rewrites whole Video Master items, and a rewrite based on a read that
predates the backfill would drop the topic again (re-running repairs that).

Defaults to a dry run (report only, no writes). Pass --execute to write.
A record that already has a valid topic is skipped; --reclassify re-derives
every topic from the title and rewrites only the ones that change.
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from stores.dynamodb_store import scan_video_topic_items, set_video_topic  # noqa: E402
from tracking.video_topics import TOPIC_IDS, classify_video_topic  # noqa: E402


def backfill_topics(*, execute: bool, reclassify: bool) -> dict[str, Any]:
    topic_counts: Counter[str] = Counter()
    summary = {
        "scanned": 0,
        "alreadyClassified": 0,
        "missingTopic": 0,
        "wouldUpdate": 0,
        "updated": 0,
        "errors": 0,
    }
    for item in scan_video_topic_items():
        summary["scanned"] += 1
        existing = item.get("topic")
        has_valid_topic = isinstance(existing, str) and existing in TOPIC_IDS
        if has_valid_topic and not reclassify:
            summary["alreadyClassified"] += 1
            continue
        if existing is not None and not has_valid_topic and not reclassify:
            print(f"Error: {item.get('videoId')!r} has an invalid topic {existing!r}; use --reclassify to replace it")
            summary["errors"] += 1
            continue
        title = item.get("title")
        if not isinstance(item.get("videoId"), str) or not isinstance(title, str) or not title.strip():
            print(f"Error: malformed Video Master record, cannot classify: {item!r}")
            summary["errors"] += 1
            continue
        topic = classify_video_topic(title)
        if existing is None:
            summary["missingTopic"] += 1
        elif existing == topic:
            summary["alreadyClassified"] += 1
            continue
        summary["wouldUpdate"] += 1
        topic_counts[topic] += 1
        if execute and set_video_topic(item["videoId"], topic, overwrite=reclassify):
            summary["updated"] += 1
    summary["topicCounts"] = {topic: topic_counts[topic] for topic in sorted(topic_counts)}
    summary["otherCount"] = topic_counts["other"]
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually write to VideoMaster. Without this flag, reports only (dry run).",
    )
    parser.add_argument(
        "--reclassify",
        action="store_true",
        help="Re-derive the topic of records that already have one, rewriting only those that change.",
    )
    args = parser.parse_args(argv)

    mode = "EXECUTE (writing to VideoMaster)" if args.execute else "DRY RUN (no writes)"
    print(f"=== Video topic backfill -- {mode} ===\n")
    summary = backfill_topics(execute=args.execute, reclassify=args.reclassify)
    for key, value in summary.items():
        print(f"{key}: {value}")
    return 1 if summary["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
