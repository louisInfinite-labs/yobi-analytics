"""Local collector: discover each active creator's videos and record today's snapshot."""

from __future__ import annotations

import sys
from datetime import datetime
from zoneinfo import ZoneInfo

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

from config import MissingAPIKeyError, get_api_key
from creator_master import Creator, get_active_creators
from googleapiclient.discovery import Resource
from snapshot_store import Snapshot, SnapshotStoreError, save_daily_snapshot
from video_discovery import discover_all_videos, discover_new_videos, get_uploads_playlist_id
from video_master import Video, VideoMasterError, load_video_ids_for_creator, load_videos, upsert_videos
from youtube_client import YouTubeAPIError, build_youtube_client, get_video_statistics

# The production schedule (Roadmap.md 2.4) runs the collector at 00:00 Asia/Tokyo.
# Snapshot dates must be derived from JST, not the server's local/UTC clock.
COLLECTION_TIMEZONE = ZoneInfo("Asia/Tokyo")


def main() -> int:
    """Discover each active creator's videos, collect statistics, and save today's snapshot."""
    try:
        api_key = get_api_key()
    except MissingAPIKeyError as exc:
        print(f"Error: {exc}")
        return 1

    active_creators = get_active_creators()
    if not active_creators:
        print("No active creators.")
        return 0

    try:
        youtube = build_youtube_client(api_key)

        # Load Video Master once for the whole run rather than once per creator,
        # and write the accumulated new videos back once at the end.
        known_videos = load_videos()

        tracking_universe: list[str] = []
        newly_discovered: list[Video] = []
        for creator in active_creators:
            known_ids = load_video_ids_for_creator(creator.creator_id, videos=known_videos)

            if not creator.discovery_enabled:
                print(
                    f"{creator.display_name} ({creator.organization}): "
                    f"discovery disabled, tracking {len(known_ids)} known video(s)"
                )
                tracking_universe.extend(known_ids)
                continue

            try:
                new_video_ids, new_videos = _discover_creator(youtube, creator, known_ids)
                print(
                    f"{creator.display_name} ({creator.organization}): "
                    f"{len(new_video_ids)} new video(s) discovered"
                )
                newly_discovered.extend(new_videos)
                tracking_universe.extend(known_ids | set(new_video_ids))
            except YouTubeAPIError as exc:
                print(f"Warning: discovery failed for {creator.display_name} ({creator.organization}): {exc}")
                tracking_universe.extend(known_ids)

        if newly_discovered:
            upsert_videos(newly_discovered)

        videos = get_video_statistics(youtube, tracking_universe)
    except (YouTubeAPIError, VideoMasterError) as exc:
        print(f"Error: {exc}")
        return 1

    if not videos:
        if tracking_universe:
            print(f"Error: {len(tracking_universe)} video(s) were tracked, but none returned usable statistics.")
            return 1
        print("No video data returned.")
        return 0

    collection_time = datetime.now(COLLECTION_TIMEZONE)
    snapshots = [
        Snapshot(video_id=video["videoId"], observed_at=collection_time.isoformat(), view_count=video["viewCount"])
        for video in videos
    ]

    try:
        snapshot_path = save_daily_snapshot(snapshots, collection_time.date())
    except (FileExistsError, SnapshotStoreError) as exc:
        print(f"Error: {exc}")
        return 1

    print(f"Saved {len(snapshots)} snapshot(s) to {snapshot_path}\n")

    for video in videos:
        print(
            f"{video['videoId']} | {video['publishedAt']} | "
            f"{video['viewCount']:>10} views | {video['title']}"
        )

    return 0


def _discover_creator(
    youtube: Resource, creator: Creator, known_ids: set[str]
) -> tuple[list[str], list[Video]]:
    """Run Initial or Incremental Discovery for one creator.

    Does not touch Video Master directly — the caller collects results
    across all creators and writes them once at the end of the run.
    """
    playlist_id = get_uploads_playlist_id(youtube, creator.youtube_channel_id)

    if known_ids:
        discovered = discover_new_videos(youtube, playlist_id, known_ids)
    else:
        discovered = discover_all_videos(youtube, playlist_id)

    videos = [
        Video(
            video_id=item["videoId"],
            creator_id=creator.creator_id,
            title=item["title"],
            published_at=item["publishedAt"],
        )
        for item in discovered
    ]
    return [video.video_id for video in videos], videos


if __name__ == "__main__":
    sys.exit(main())
