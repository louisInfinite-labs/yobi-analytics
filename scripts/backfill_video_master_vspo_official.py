"""One-time targeted VideoMaster backfill for onboarding the VSPO official
channel (@Vspo77) as a brand-new creator.

Reuses the exact same safe onboarding pattern already used for
elizabeth_rose_bloodflame/gigi_murin (scripts/backfill_video_master.py):
populate YobiVideoMaster for this ONE creator's known_ids BEFORE it is added
to creators.json, so the very next ordinary collector run after adding it
sees a non-empty known_ids and only ever treats genuinely new uploads as
"new" -- never the creator's entire back catalog.

Deliberately narrow, mirroring scripts/backfill_video_master.py's own
narrowness: AUTHORIZED_CHANNEL_ID is the one hardcoded creatorId ->
youtubeChannelId mapping this script will ever touch, independently verified
(public @Vspo77 handle page + the channel's own RSS feed, both keyed by this
exact channel ID) before this script was written -- see the V1 identity
verification report. Kept as its own script rather than extending
backfill_video_master.py's CORRECTED_CHANNEL_IDS: that script's docstring
frames its two entries as "the ONLY creators this script will ever touch" for
a *channel-ID-correction* event; this is a *new-creator-onboarding* event, a
different concern that deserves its own narrow, independently-reviewable
allowlist rather than growing an unrelated one.

What this script deliberately does NOT do (same guarantees as
backfill_video_master.py):
- does not call record_new_video_events / send any notification (this module
  never imports notification_events_store or notification_dispatch at all)
- does not write to YobiSnapshots or invent any view-count/statistics field
- does not touch YobiTrendingCache
- does not touch S3 history in any way
- does not publish the tracking manifest -- left to the next ordinary
  collector run, once creators.json is actually updated
- does not modify creators.json

Defaults to a dry run (report only, no writes). Pass --execute to actually
write to VideoMaster.
"""

from __future__ import annotations

import argparse
import sys

from ops.config import MissingAPIKeyError, get_api_key
from tracking.video_discovery import discover_all_videos, get_uploads_playlist_id
from tracking.video_master import Video
from collection.youtube_client import YouTubeAPIError, build_youtube_client

# Reuses backfill_video_master.py's own existing-ids/upsert helpers
# unchanged -- same storage-backend switch (YOBI_STORAGE_BACKEND=dynamodb
# selects the real production backend), same upsert-by-videoId idempotency.
from backfill_video_master import _load_existing_video_ids, _upsert_videos  # noqa: E402

AUTHORIZED_CREATOR_ID = "vspo_official"
AUTHORIZED_CHANNEL_ID = "UCuI5XaO-6VkOEhHao6ij7JA"

# YouTube Data API quota (playlistItems.list): 1 unit per page of up to 50
# items, regardless of items.list vs playlistItems.list -- discover_all_videos
# never calls videos.list, so total cost is exactly ceil(videosFound / 50)
# units, plus 1 unit for the channels.list call in get_uploads_playlist_id.
PLAYLIST_PAGE_SIZE = 50


class UnauthorizedCreatorError(ValueError):
    """Raised when asked to process a creatorId/channel_id other than the one
    this script is authorized for."""


def backfill_vspo_official(youtube, *, execute: bool) -> dict:
    """Discover every upload for the VSPO official channel and report/insert
    whatever isn't already in VideoMaster. Returns a summary dict."""
    playlist_id = get_uploads_playlist_id(youtube, AUTHORIZED_CHANNEL_ID)
    discovered = discover_all_videos(youtube, playlist_id)

    existing_ids = _load_existing_video_ids(AUTHORIZED_CREATOR_ID)

    from datetime import datetime, timezone

    discovered_at = datetime.now(timezone.utc).isoformat()
    to_insert = [
        Video(
            video_id=item["videoId"],
            creator_id=AUTHORIZED_CREATOR_ID,
            title=item["title"],
            published_at=item["publishedAt"],
            discovered_at=discovered_at,
        )
        for item in discovered
        if item["videoId"] not in existing_ids
    ]

    published_ats = [item["publishedAt"] for item in discovered]
    quota_units = 1 + -(-len(discovered) // PLAYLIST_PAGE_SIZE) if discovered else 1

    summary = {
        "creatorId": AUTHORIZED_CREATOR_ID,
        "channelId": AUTHORIZED_CHANNEL_ID,
        "videosFound": len(discovered),
        "alreadyExisting": len(discovered) - len(to_insert),
        "toInsert": len(to_insert),
        "oldestPublishedAt": min(published_ats) if published_ats else None,
        "newestPublishedAt": max(published_ats) if published_ats else None,
        "estimatedQuotaUnits": quota_units,
    }

    if execute and to_insert:
        _upsert_videos(to_insert)

    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually write to VideoMaster. Without this flag, reports only (dry run).",
    )
    args = parser.parse_args(argv)

    try:
        api_key = get_api_key()
    except MissingAPIKeyError as exc:
        print(f"Error: {exc}")
        return 1

    youtube = build_youtube_client(api_key)

    mode = "EXECUTE (writing to VideoMaster)" if args.execute else "DRY RUN (no writes)"
    print(f"=== VSPO official channel targeted backfill -- {mode} ===\n")

    try:
        summary = backfill_vspo_official(youtube, execute=args.execute)
    except YouTubeAPIError as exc:
        print(f"Error backfilling {AUTHORIZED_CREATOR_ID!r}: {exc}")
        return 1

    action_label = "inserted" if args.execute else "would insert"
    print(f"{summary['creatorId']} ({summary['channelId']}):")
    print(f"  videos found:        {summary['videosFound']}")
    print(f"  already existing:    {summary['alreadyExisting']}")
    print(f"  {action_label}:{' ' * (13 - len(action_label))}{summary['toInsert']}")
    print(f"  oldest publishedAt:  {summary['oldestPublishedAt']}")
    print(f"  newest publishedAt:  {summary['newestPublishedAt']}")
    print(f"  estimated quota:     {summary['estimatedQuotaUnits']} units")

    return 0


if __name__ == "__main__":
    sys.exit(main())
