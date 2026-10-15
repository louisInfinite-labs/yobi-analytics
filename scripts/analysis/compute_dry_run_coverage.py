"""Read-only: independently reproduces classification-coverage numbers for PROPOSED_TOPICS
(scripts/analysis/proposed_topic_classification.py) against the real, already-scanned production
corpus. Never writes to AWS, never writes to the repo's own src/ or TOPICS. Reads a local JSONL
dump of YobiVideoMaster (videoId/title/topic) produced by an earlier read-only Scan this session;
point SOURCE_PATH at your own dump if re-running elsewhere.

Usage:
    .venv/Scripts/python.exe scripts/analysis/compute_dry_run_coverage.py <path-to-all_titles.jsonl>
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "src"))

from scripts.analysis.proposed_topic_classification import PROPOSED_TOPICS  # noqa: E402
from tracking.video_topics import TOPICS  # noqa: E402


def main() -> int:
    source_path = sys.argv[1] if len(sys.argv) > 1 else "all_titles.jsonl"

    compiled = [(topic.id, re.compile(topic.pattern)) for topic in PROPOSED_TOPICS]

    total = 0
    persisted_topic_counts: Counter[str] = Counter()
    other_video_ids: set[str] = set()
    newly_classified_ids: set[str] = set()

    with open(source_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            total += 1
            persisted = rec.get("topic") or "other"
            persisted_topic_counts[persisted] += 1
            if persisted != "other":
                continue

            video_id = rec["videoId"]
            other_video_ids.add(video_id)
            normalized = unicodedata.normalize("NFKC", rec.get("title") or "").casefold()
            for topic_id, pattern in compiled:
                if pattern.search(normalized):
                    newly_classified_ids.add(video_id)
                    break

    n_other = len(other_video_ids)
    n_new = len(newly_classified_ids)
    n_remaining = n_other - n_new
    baseline_coverage = (total - n_other) / total
    new_overall_coverage = (total - n_remaining) / total

    print(f"Total videos: {total}")
    print(f"Persisted topic breakdown: {dict(persisted_topic_counts)}")
    print(f"Existing 8-topic taxonomy ids match TOPICS: {sorted(persisted_topic_counts) == sorted(t.id for t in TOPICS)}")
    print()
    print(f"'other' bucket (before proposal): {n_other} ({n_other/total:.2%} of all videos)")
    print(f"PROPOSED_TOPICS candidates: {len(PROPOSED_TOPICS)}")
    print(f"Newly classified by PROPOSED_TOPICS: {n_new} ({n_new/n_other:.2%} of other-bucket)")
    print(f"Remaining 'other' after adopting all {len(PROPOSED_TOPICS)}: {n_remaining} ({n_remaining/n_other:.2%} of other-bucket)")
    print()
    print(f"Overall classification coverage: {baseline_coverage:.2%} -> {new_overall_coverage:.2%}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
