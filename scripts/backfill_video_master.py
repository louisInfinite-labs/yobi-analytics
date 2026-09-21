"""One-time targeted VideoMaster backfill for two creators whose youtubeChannelId
was found to be wrong in production creators.json (channel-identity audit).

Populates YobiVideoMaster for exactly elizabeth_rose_bloodflame and gigi_murin,
using their CORRECTED YouTube channel IDs, deliberately run BEFORE production
creators.json is corrected. Both creatorIds currently have zero known videos
(confirmed via a read-only creatorId-index query), so the very next ordinary
collector run after correcting creators.json would otherwise see known_ids as
empty and treat every historical upload as "newly discovered" -- triggering a
notification event (and a real push notification) for each one. Running this
backfill first means known_ids is no longer empty by the time creators.json is
corrected, so that later run only ever sees genuinely new uploads going forward.

Deliberately narrow, not a general-purpose backfill tool: the two creatorId ->
corrected-channel-ID mappings are hardcoded in CORRECTED_CHANNEL_IDS and are the
ONLY creators this script will ever touch. The mapping is hardcoded rather than
read from creators.json because creators.json still holds the WRONG channel ID
in production -- the whole point of running this first is to not depend on that
file being corrected yet.

What this script deliberately does NOT do:
- does not call record_new_video_events / send any notification (this module
  never imports notification_events_store or notification_dispatch at all)
- does not write to YobiSnapshots or invent any view-count/statistics field --
  YouTube's Data API only exposes current stats, never a historical time
  series, so there is nothing honest to backfill there; every inserted Video
  keeps its normal bootstrap defaults (activity_state="Unknown", 0 snapshots)
- does not touch YobiTrendingCache
- does not publish the tracking manifest -- left to the next ordinary collector
  run, which already does this unconditionally with the full known_videos list

Defaults to a dry run (report only, no writes). Pass --execute to actually
write to VideoMaster.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from typing import Any

from ops.config import MissingAPIKeyError, get_api_key
from tracking.video_discovery import discover_all_videos, get_uploads_playlist_id
from tracking.video_master import Video
from collection.youtube_client import YouTubeAPIError, build_youtube_client

# The ONLY two creators this script is authorized to process -- see the module
# docstring for why. Independently verified against each channel's own
# canonical YouTube URL before this script was written.
CORRECTED_CHANNEL_IDS: dict[str, str] = {
    "elizabeth_rose_bloodflame": "UCW5uhrG1eCBYditmhL0Ykjw",
    "gigi_murin": "UCDHABijvPBnJm7F-KlNME3w",
}


class UnauthorizedCreatorError(ValueError):
    """Raised when asked to process a creatorId/channel_id outside CORRECTED_CHANNEL_IDS."""


def _load_existing_video_ids(creator_id: str) -> set[str]:
    """Every videoId already known for creator_id, via whichever backend production uses."""
    if os.environ.get("YOBI_STORAGE_BACKEND") == "dynamodb":
        from stores.dynamodb_store import get_videos_by_creator

        return {video.video_id for video in get_videos_by_creator(creator_id)}
    from tracking.video_master import load_videos

    return {video.video_id for video in load_videos() if video.creator_id == creator_id}


def _upsert_videos(videos: list[Video]) -> None:
    """Write via whichever backend production uses -- same upsert-by-videoId
    semantics either way, so re-running this script is naturally idempotent."""
    if os.environ.get("YOBI_STORAGE_BACKEND") == "dynamodb":
        from stores.dynamodb_store import upsert_videos
    else:
        from tracking.video_master import upsert_videos
    upsert_videos(videos)


def backfill_creator(youtube: Any, creator_id: str, channel_id: str, *, execute: bool) -> dict[str, Any]:
    """Discover every upload for one creator's corrected channel and report/insert
    whatever isn't already in VideoMaster. Returns a summary dict for reporting.

    Raises UnauthorizedCreatorError for anything outside CORRECTED_CHANNEL_IDS --
    checked first, before any YouTube API call or storage read.
    """
    if creator_id not in CORRECTED_CHANNEL_IDS:
        raise UnauthorizedCreatorError(
            f"{creator_id!r} is not one of the two creators this backfill script is "
            f"authorized for: {sorted(CORRECTED_CHANNEL_IDS)}"
        )
    if CORRECTED_CHANNEL_IDS[creator_id] != channel_id:
        raise UnauthorizedCreatorError(
            f"channel_id {channel_id!r} does not match the confirmed-correct channel ID "
            f"for {creator_id!r} ({CORRECTED_CHANNEL_IDS[creator_id]!r})"
        )

    playlist_id = get_uploads_playlist_id(youtube, channel_id)
    discovered = discover_all_videos(youtube, playlist_id)

    existing_ids = _load_existing_video_ids(creator_id)
    discovered_at = datetime.now(timezone.utc).isoformat()

    to_insert = [
        Video(
            video_id=item["videoId"],
            creator_id=creator_id,
            title=item["title"],
            published_at=item["publishedAt"],
            discovered_at=discovered_at,
        )
        for item in discovered
        if item["videoId"] not in existing_ids
    ]

    published_ats = [item["publishedAt"] for item in discovered]

    summary = {
        "creatorId": creator_id,
        "videosFound": len(discovered),
        "alreadyExisting": len(discovered) - len(to_insert),
        "toInsert": len(to_insert),
        "oldestPublishedAt": min(published_ats) if published_ats else None,
        "newestPublishedAt": max(published_ats) if published_ats else None,
    }

    if execute and to_insert:
        _upsert_videos(to_insert)

    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--creator-id",
        choices=sorted(CORRECTED_CHANNEL_IDS),
        help="Process only this creator (default: both).",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually write to VideoMaster. Without this flag, reports only (dry run).",
    )
    args = parser.parse_args(argv)

    creator_ids = [args.creator_id] if args.creator_id else sorted(CORRECTED_CHANNEL_IDS)

    try:
        api_key = get_api_key()
    except MissingAPIKeyError as exc:
        print(f"Error: {exc}")
        return 1

    youtube = build_youtube_client(api_key)

    mode = "EXECUTE (writing to VideoMaster)" if args.execute else "DRY RUN (no writes)"
    print(f"=== Targeted backfill -- {mode} ===\n")

    exit_code = 0
    for creator_id in creator_ids:
        try:
            summary = backfill_creator(youtube, creator_id, CORRECTED_CHANNEL_IDS[creator_id], execute=args.execute)
        except (YouTubeAPIError, UnauthorizedCreatorError) as exc:
            print(f"Error backfilling {creator_id!r}: {exc}")
            exit_code = 1
            continue
        action_label = "inserted" if args.execute else "would insert"
        print(f"{creator_id}:")
        print(f"  videos found:       {summary['videosFound']}")
        print(f"  already existing:   {summary['alreadyExisting']}")
        print(f"  {action_label}:{' ' * (12 - len(action_label))}{summary['toInsert']}")
        print(f"  oldest publishedAt: {summary['oldestPublishedAt']}")
        print(f"  newest publishedAt: {summary['newestPublishedAt']}")
        print()

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
