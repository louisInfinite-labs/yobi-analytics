"""Local collector: discover each active creator's videos and record today's snapshot."""

from __future__ import annotations

import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

from config import MissingAPIKeyError, get_api_key
from creator_master import Creator, get_active_creators
from googleapiclient.discovery import Resource
from snapshot_store import SkippedVideo, Snapshot, SnapshotRunSummary, SnapshotStoreError
from tracking_manifest import (
    S3TrackingManifestStore,
    TrackingManifestError,
    publish_tracking_manifest,
)
from video_discovery import discover_all_videos, discover_new_videos, get_uploads_playlist_id
from video_master import Video, VideoMasterError, load_video_ids_for_creator
from youtube_client import QuotaExhaustedError, YouTubeAPIError, build_youtube_client, get_video_statistics

# Local/manual collection retains the existing JSON or DynamoDB adapter.
# The scheduled production history path is now history_worker_handler:
# manifest input and daily Parquet output in S3. This compatibility entry
# point still shares discovery and run-summary behavior while no longer
# applying adaptive eligibility or rewriting scheduler state.
if os.environ.get("YOBI_STORAGE_BACKEND") == "dynamodb":
    from dynamodb_store import load_videos, save_daily_collection, save_run_summary, upsert_videos
    from notification_events_store import NotificationEventsStoreError, record_new_video_events
else:
    from snapshot_store import save_daily_collection, save_run_summary
    from video_master import load_videos, upsert_videos

    class NotificationEventsStoreError(Exception):
        """Placeholder so main.py's except clause is valid locally; never raised (see below)."""

    def record_new_video_events(videos: list[Video]) -> None:
        """No-op locally — the Roadmap 4.6 notification dispatcher only exists once deployed to AWS."""

# The production schedule (Roadmap.md 2.4) runs the collector at 18:00 Asia/Tokyo.
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

    collection_time = datetime.now(COLLECTION_TIMEZONE)

    try:
        youtube = build_youtube_client(api_key)

        creator_by_id = {creator.creator_id: creator for creator in active_creators}

        # Load Video Master once for the whole run rather than once per creator,
        # and write the accumulated new videos back once at the end.
        known_videos = load_videos()
        creator_id_by_video_id = {video.video_id: video.creator_id for video in known_videos}

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
                new_video_ids, new_videos = _discover_creator(
                    youtube, creator, known_ids, discovered_at=collection_time.isoformat()
                )
                print(
                    f"{creator.display_name} ({creator.organization}): "
                    f"{len(new_video_ids)} new video(s) discovered"
                )
                newly_discovered.extend(new_videos)
                creator_id_by_video_id.update({video.video_id: video.creator_id for video in new_videos})
                tracking_universe.extend(known_ids | set(new_video_ids))
            except QuotaExhaustedError as exc:
                # Roadmap 2.5: once quota is exhausted, every remaining creator's
                # discovery call would fail the same way — stop issuing new
                # requests immediately instead of burning through the rest of
                # the creator list one preventable failure at a time. Videos
                # already discovered from earlier creators this run are real,
                # paid-for results — persist them before stopping, rather
                # than losing them along with the exception. Statistics
                # collection never started this run, so there is no partial
                # day and no `due_today` list to fall back on — unlike a
                # mid-stats quota exhaustion (handled below), this must
                # return here rather than propagate into that handler.
                if newly_discovered:
                    try:
                        upsert_videos(newly_discovered)
                        _publish_manifest_if_configured([*known_videos, *newly_discovered])
                    except (VideoMasterError, TrackingManifestError) as upsert_exc:
                        print(f"Error: failed to persist discovered videos before stopping: {upsert_exc}")
                        return 1
                    _record_new_video_events_best_effort(newly_discovered)
                print(f"Error: YouTube quota exhausted during discovery: {exc}")
                return 1
            except YouTubeAPIError as exc:
                print(f"Warning: discovery failed for {creator.display_name} ({creator.organization}): {exc}")
                tracking_universe.extend(known_ids)

        if newly_discovered:
            upsert_videos(newly_discovered)
            _record_new_video_events_best_effort(newly_discovered)
        _publish_manifest_if_configured([*known_videos, *newly_discovered])

        # Architecture reset: every tracked video is due every day. Legacy
        # Hot/Warm/Cold fields remain readable for compatibility, but cannot
        # suppress collection. Sorting makes batches deterministic and the
        # set prevents duplicate requests if the catalog is malformed.
        due_today = sorted(set(tracking_universe))
        print(f"Tracking universe: {len(due_today)} video(s), all due for a check today\n")

        videos, skip_reasons = get_video_statistics(youtube, due_today)
    except QuotaExhaustedError as exc:
        # Roadmap 2.5: statistics already fetched before quota ran out are
        # real, already-paid-for results — treat them exactly as if
        # get_video_statistics had returned normally (the rest of this
        # function already knows how to persist a partial day and record
        # why the remaining videos are missing), rather than discarding them
        # along with the exception.
        print(f"Warning: YouTube quota exhausted mid-run, saving partial results: {exc}")
        videos = exc.partial_results
        skip_reasons = {
            **exc.partial_skip_reasons,
            **{video_id: f"YouTube quota exhausted: {exc}" for video_id in exc.remaining_video_ids},
        }
    except (YouTubeAPIError, VideoMasterError, TrackingManifestError) as exc:
        print(f"Error: {exc}")
        return 1

    # Roadmap 1.6 "Known Issue": due_today videos that didn't come back with
    # usable statistics (a failed batch, a member-only video, etc.) are
    # simply absent from `videos`. That's recorded in a persisted run summary
    # — including *why* each one was skipped (a YouTube API failure vs. a
    # malformed/missing item), not just a log line — so a partial or
    # fully-failed run can be checked later from stored data instead of
    # console output. Saved even when every batch failed (collected_count=0),
    # since that's the case future analytics needs the record for the most.
    collected_ids = {video["videoId"] for video in videos}
    skipped_video_ids = [video_id for video_id in due_today if video_id not in collected_ids]
    skipped = [
        SkippedVideo(video_id=video_id, reason=skip_reasons.get(video_id, "Unknown: not returned by statistics collection"))
        for video_id in skipped_video_ids
    ]
    snapshot_date = collection_time.date().isoformat()

    if not videos:
        if due_today:
            run_summary = SnapshotRunSummary(
                snapshot_date=snapshot_date,
                requested_count=len(due_today),
                collected_count=0,
                skipped=skipped,
            )
            try:
                save_run_summary(run_summary, collection_time.date())
            except (FileExistsError, SnapshotStoreError) as exc:
                print(f"Error: {exc}")
                return 1
            print(f"Error: {len(due_today)} video(s) were due for a check, but none returned usable statistics.")
            return 1
        print("No video data returned.")
        return 0

    if skipped_video_ids:
        print(f"Warning: collected {len(videos)}/{len(due_today)} due video(s); {len(skipped_video_ids)} skipped\n")

    observed_at = collection_time.isoformat()
    snapshots = [
        Snapshot(
            snapshot_date=snapshot_date,
            observed_at=observed_at,
            creator_id=creator_id_by_video_id[video["videoId"]],
            video_id=video["videoId"],
            title=video["title"],
            published_at=video["publishedAt"],
            view_count=video["viewCount"],
            organization=creator_by_id[creator_id_by_video_id[video["videoId"]]].organization,
        )
        for video in videos
    ]

    run_summary = SnapshotRunSummary(
        snapshot_date=snapshot_date,
        requested_count=len(due_today),
        collected_count=len(videos),
        skipped=skipped,
    )

    try:
        snapshot_path, summary_path = save_daily_collection(snapshots, run_summary, collection_time.date())
    except (FileExistsError, SnapshotStoreError) as exc:
        print(f"Error: {exc}")
        return 1

    print(f"Saved {len(snapshots)} snapshot(s) to {snapshot_path}")
    print(f"Saved run summary to {summary_path}\n")

    for video in videos:
        print(
            f"{video['videoId']} | {video['publishedAt']} | "
            f"{video['viewCount']:>10} views | {video['title']}"
        )

    return 0


def run_discovery() -> int:
    """Discovery-only run (JST 00:00 trigger): find and persist new videos for every active
    creator, without collecting statistics.

    A separate, lighter invocation from main()'s own 18:00 run, so a new
    video's notification (record_new_video_events) can fire hours earlier
    than waiting for the heavier statistics-collection run to also handle
    discovery, and so the collector's daily YouTube API/DynamoDB load is
    spread across two smaller windows instead of one long one. Deliberately
    duplicates main()'s own discovery-loop shape (accepting the small
    repetition) rather than extracting a shared helper, so this additive
    change carries no risk of altering main()'s own already-relied-upon
    control flow.
    """
    try:
        api_key = get_api_key()
    except MissingAPIKeyError as exc:
        print(f"Error: {exc}")
        return 1

    active_creators = get_active_creators()
    if not active_creators:
        print("No active creators.")
        return 0

    discovered_at = datetime.now(COLLECTION_TIMEZONE).isoformat()
    newly_discovered: list[Video] = []
    quota_exhausted = False

    try:
        youtube = build_youtube_client(api_key)
        known_videos = load_videos()

        for creator in active_creators:
            if not creator.discovery_enabled:
                continue
            known_ids = load_video_ids_for_creator(creator.creator_id, videos=known_videos)
            try:
                new_video_ids, new_videos = _discover_creator(
                    youtube, creator, known_ids, discovered_at=discovered_at
                )
                print(f"{creator.display_name} ({creator.organization}): {len(new_video_ids)} new video(s) discovered")
                newly_discovered.extend(new_videos)
            except QuotaExhaustedError as exc:
                # Matches main()'s own Roadmap 2.5 handling: stop issuing new
                # requests immediately, but persist whatever earlier creators
                # already found (below) rather than losing it.
                print(f"Error: YouTube quota exhausted during discovery: {exc}")
                quota_exhausted = True
                break
            except YouTubeAPIError as exc:
                print(f"Warning: discovery failed for {creator.display_name} ({creator.organization}): {exc}")
    except (YouTubeAPIError, VideoMasterError) as exc:
        print(f"Error: {exc}")
        return 1

    if newly_discovered:
        try:
            upsert_videos(newly_discovered)
        except VideoMasterError as exc:
            print(f"Error: failed to persist discovered videos: {exc}")
            return 1
        _record_new_video_events_best_effort(newly_discovered)

    try:
        _publish_manifest_if_configured([*known_videos, *newly_discovered])
    except TrackingManifestError as exc:
        print(f"Error: failed to publish tracking manifest: {exc}")
        return 1

    if quota_exhausted:
        return 1

    print(f"Discovery complete: {len(newly_discovered)} new video(s) found across {len(active_creators)} creator(s)")
    return 0


def _record_new_video_events_best_effort(newly_discovered: list[Video]) -> None:
    """Record a Roadmap 4.6 notification event for each newly discovered video.

    Best-effort: a video is already durably tracked in Video Master by the
    time this runs (the caller always calls upsert_videos first), so a
    failure here means the Roadmap 4.6 notification dispatcher misses one
    run's worth of new-video events — worth a warning, not a reason to fail
    a collection run that otherwise succeeded.
    """
    try:
        record_new_video_events(newly_discovered)
    except NotificationEventsStoreError as exc:
        print(f"Warning: failed to record notification events for {len(newly_discovered)} video(s): {exc}")


def _publish_manifest_if_configured(videos: list[Video]) -> None:
    """Publish the complete catalog only in the configured S3 architecture."""
    bucket_name = os.environ.get("YOBI_HISTORY_BUCKET")
    if not bucket_name:
        return
    # Last occurrence wins so a just-discovered record replaces an older
    # master copy if the caller supplied both.
    current = {video.video_id: video for video in videos}
    publish_tracking_manifest(
        list(current.values()),
        S3TrackingManifestStore(bucket_name),
    )


def _discover_creator(
    youtube: Resource, creator: Creator, known_ids: set[str], *, discovered_at: str
) -> tuple[list[str], list[Video]]:
    """Run Initial or Incremental Discovery for one creator.

    Does not touch Video Master directly — the caller collects results
    across all creators and writes them once at the end of the run.
    `discovered_at` (this run's own timestamp) is stamped onto every newly
    found video — see Video.discovered_at for why this is distinct from
    `published_at`.
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
            discovered_at=discovered_at,
        )
        for item in discovered
    ]
    return [video.video_id for video in videos], videos


if __name__ == "__main__":
    sys.exit(main())
