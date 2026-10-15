"""One-off / re-runnable: seed the global Topic Catalog (DynamoDB table YobiTopicCatalog) from
tracking.video_topics.TOPICS -- the Home Topic Filter's GET /topics now reads this table instead
of iterating that tuple directly (see api.dashboard_catalog_api.get_topics).

Idempotent by design: each topic is a plain PutItem keyed on (catalog_id="GLOBAL", topic_tag), so
re-running this script after TOPICS gains a new entry upserts only what changed -- no duplicates,
no need to track what was already seeded. This is also the catalog's ONLY update mechanism today:
tracking.video_topics.classify_video_topic can only ever return an id already in TOPICS (a closed
regex-matched vocabulary), so a brand new topic always starts as a code change there, followed by
re-running this script -- never a runtime discovery from a classified video.

Usage:
    .venv/Scripts/python.exe scripts/migration/seed_topic_catalog_dynamodb.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from stores.topic_catalog_store import put_topic, query_global_topics  # noqa: E402
from tracking.video_topics import TOPICS  # noqa: E402

# Backward compatibility only: GET /topics' original single-string `label` field, byte-identical to
# what that endpoint returned before `labels` (per-locale text) existed. See
# api.dashboard_catalog_api.get_topics' own docstring for why this is never removed. A topic added
# after `labels` already existed (not one of the 8 below) has no historical label to preserve, so
# get_topics falls back to that topic's own English label when seeded without one here.
_LEGACY_TOPIC_LABELS: dict[str, str] = {
    "valorant": "VALORANT",
    "sf6": "SF6",
    "apex": "APEX",
    "minecraft": "Minecraft",
    "singing": "Singing",
    "mv": "MV",
    "chatting": "Chatting",
    "other": "Other",
}


def main() -> int:
    """Upsert every TOPICS entry into YobiTopicCatalog, then read the catalog back and verify
    it now holds exactly one record per TOPICS entry -- never fewer (a silently dropped topic)
    and never more (a leftover record for a topic since removed from TOPICS)."""
    for display_order, topic in enumerate(TOPICS):
        print(f"Seeding {topic.id} ({display_order})...")
        put_topic(
            topic_tag=topic.id,
            topic_zh=topic.labels["zh-TW"],
            topic_en=topic.labels["en"],
            topic_ja=topic.labels["ja"],
            display_order=display_order,
            legacy_label=_LEGACY_TOPIC_LABELS.get(topic.id),
            search_aliases=topic.search_aliases,
        )

    expected_ids = {topic.id for topic in TOPICS}
    stored = query_global_topics()
    stored_ids = {item["topic_tag"] for item in stored}

    missing = expected_ids - stored_ids
    unexpected = stored_ids - expected_ids
    if missing:
        print(f"MISSING from catalog after seeding: {sorted(missing)}")
    if unexpected:
        print(f"UNEXPECTED catalog records (not in current TOPICS): {sorted(unexpected)}")

    for item in sorted(stored, key=lambda i: i["display_order"]):
        has_all_four = all(item.get(k) for k in ("topic_tag", "topic_zh", "topic_en", "topic_ja"))
        print(f"  {item['topic_tag']}: zh={item['topic_zh']!r} en={item['topic_en']!r} ja={item['topic_ja']!r}"
              f" {'OK' if has_all_four else 'MISSING A MANDATORY FIELD'}")

    print(f"\n{len(stored)} record(s) in catalog, {len(expected_ids)} expected.")
    return 0 if not missing and not unexpected and len(stored) == len(expected_ids) else 1


if __name__ == "__main__":
    sys.exit(main())
