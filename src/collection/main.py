"""Local collector: discover each active creator's videos and record today's snapshot."""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

from ops.config import MissingAPIKeyError, get_api_key
from stores.history_store import HISTORY_SHARD_COUNT, shard_for_video
from tracking.creator_master import Creator, get_active_creators
from googleapiclient.discovery import Resource
from stores.snapshot_store import SkippedVideo, Snapshot, SnapshotRunSummary, SnapshotStoreError
from tracking.tracking_manifest import ManifestEntry, S3TrackingManifestStore, patch_shard, publish_tracking_manifest
from tracking.tracking_schedule import select_due_video_ids
from tracking.video_discovery import discover_all_videos, discover_new_videos, get_uploads_playlist_id
from tracking.video_master import Video, VideoMasterError, load_video_ids_for_creator
from tracking.video_topics import classify_video_topic
from collection.youtube_client import QuotaExhaustedError, YouTubeAPIError, build_youtube_client, get_video_statistics

# Local/manual collection retains the existing JSON or DynamoDB adapter.
# The scheduled production history path is now history_worker_handler:
# manifest input and daily Parquet output in S3. This compatibility entry
# point still shares discovery and run-summary behavior. Due-selection
# (tracking_schedule.select_due_video_ids) reads each video's existing
# published_at/activity_state to decide eligibility, but this entry point
# still never rewrites scheduler state itself (activity_state, snapshot_count,
# etc. stay exactly as Video Master already had them after a run) --
# see test_successful_collection_does_not_rewrite_video_master_scheduler_state.
if os.environ.get("YOBI_STORAGE_BACKEND") == "dynamodb":
    from stores.dynamodb_store import load_videos, save_daily_collection, save_run_summary, upsert_videos
    from stores.notification_events_store import NotificationEventsStoreError, record_new_video_events
else:
    from stores.snapshot_store import save_daily_collection, save_run_summary
    from tracking.video_master import load_videos, upsert_videos

    class NotificationEventsStoreError(Exception):
        """Placeholder so main.py's except clause is valid locally; never raised (see below)."""

    def record_new_video_events(videos: list[Video]) -> None:
        """No-op locally — the Roadmap 4.6 notification dispatcher only exists once deployed to AWS."""

# The production schedule (Roadmap.md 2.4) runs the collector at 18:00 Asia/Tokyo.
# Snapshot dates must be derived from JST, not the server's local/UTC clock.
COLLECTION_TIMEZONE = ZoneInfo("Asia/Tokyo")

# A creator with no known videos is being ingested for the first time (or has
# only ever been empty), so everything discovered is back catalog rather than a
# new upload. Only videos younger than one discovery interval still notify, so
# the first real upload of a previously empty channel is not swallowed. Known
# limitation: such an upload discovered more than this long after publication,
# while the creator still has no known videos, is seeded without a notification.
FIRST_INGESTION_NOTIFY_WINDOW = timedelta(hours=24)


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
        first_ingestion_creator_ids: set[str] = set()
        for creator in active_creators:
            known_ids = load_video_ids_for_creator(creator.creator_id, videos=known_videos)

            if not creator.discovery_enabled:
                print(
                    f"{creator.display_name} ({creator.organization}): "
                    f"discovery disabled, tracking {len(known_ids)} known video(s)"
                )
                tracking_universe.extend(known_ids)
                continue

            if not known_ids:
                first_ingestion_creator_ids.add(creator.creator_id)
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
                    except VideoMasterError as upsert_exc:
                        print(f"Error: failed to persist discovered videos before stopping: {upsert_exc}")
                        return 1
                    _publish_manifest_if_configured([*known_videos, *newly_discovered])
                    _record_new_video_events_best_effort(newly_discovered, first_ingestion_creator_ids, collection_time)
                print(f"Error: YouTube quota exhausted during discovery: {exc}")
                return 1
            except YouTubeAPIError as exc:
                print(f"Warning: discovery failed for {creator.display_name} ({creator.organization}): {exc}")
                tracking_universe.extend(known_ids)

        if newly_discovered:
            upsert_videos(newly_discovered)
            _record_new_video_events_best_effort(newly_discovered, first_ingestion_creator_ids, collection_time)
        _publish_manifest_if_configured([*known_videos, *newly_discovered])

        # Restored tiered due-selection (Roadmap 1.5, tracking_schedule.py):
        # a video published within the last RECENT_MAX_AGE_DAYS days is
        # always due; beyond that, activity_state (Hot/Warm/Cold/Unknown)
        # governs the cadence.
        # The set prevents duplicate lookups if the catalog is malformed.
        # video_by_id covers every id tracking_universe can contain (already-
        # known videos plus this run's own newly_discovered ones); a video
        # id somehow missing a record is included unconditionally, matching
        # is_due_today's own "can't tell, so check it today" fallback.
        video_by_id = {video.video_id: video for video in known_videos}
        video_by_id.update({video.video_id: video for video in newly_discovered})
        tracked_ids = set(tracking_universe)
        as_of_date = collection_time.date()
        known_candidates = [
            (video_id, video_by_id[video_id].published_at, video_by_id[video_id].activity_state)
            for video_id in tracked_ids
            if video_id in video_by_id
        ]
        missing_record_ids = tracked_ids - video_by_id.keys()
        due_today = sorted(set(select_due_video_ids(known_candidates, as_of=as_of_date)) | missing_record_ids)
        print(f"Tracking universe: {len(tracked_ids)} video(s); {len(due_today)} due for a check today\n")

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
    except (YouTubeAPIError, VideoMasterError) as exc:
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

    run_time = datetime.now(COLLECTION_TIMEZONE)
    discovered_at = run_time.isoformat()
    newly_discovered: list[Video] = []
    first_ingestion_creator_ids: set[str] = set()
    quota_exhausted = False

    try:
        youtube = build_youtube_client(api_key)
        known_ids_by_creator = _known_ids_by_creator()

        for creator in active_creators:
            if not creator.discovery_enabled:
                continue
            known_ids = known_ids_by_creator.get(creator.creator_id, set())
            if not known_ids:
                first_ingestion_creator_ids.add(creator.creator_id)
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
        _record_new_video_events_best_effort(newly_discovered, first_ingestion_creator_ids, run_time)

    _patch_manifest_with_new_videos_if_configured(newly_discovered)

    if quota_exhausted:
        return 1

    print(f"Discovery complete: {len(newly_discovered)} new video(s) found across {len(active_creators)} creator(s)")
    return 0


def _known_ids_by_creator() -> dict[str, set[str]]:
    """Every already-known video id, grouped by creator, from whichever source
    this environment's own daily discovery actually depends on for that.

    AWS Cost Recovery (third pass): when the S3 tracking manifest is
    configured (YOBI_HISTORY_BUCKET set -- the real deployed Lambda
    environment, where YOBI_STORAGE_BACKEND=dynamodb also holds), this reads
    the manifest's own HISTORY_SHARD_COUNT shards (an O(shards) S3 read, a
    fixed 16 GetObjects regardless of catalog size) instead of load_videos()
    (an O(total catalog) DynamoDB Scan) -- the manifest already carries every
    known video_id/creator_id pair, since discovery is the only writer that
    ever adds a new one; history_worker's own scheduler-state patches
    (collection.history_worker._patch_manifest_activity_state) only ever
    change an existing entry's activity_state, never add or remove one.
    A shard that doesn't exist yet (a brand-new environment, before the very
    first video for that shard's own hash range was ever discovered) reads
    back as empty via read_shard_for_patch, not an error.

    Local/manual development (no YOBI_HISTORY_BUCKET) has no manifest to read
    from at all and falls back to load_videos() unchanged -- there, it's a
    free local-JSON-file read (or, with YOBI_STORAGE_BACKEND=dynamodb set
    without a bucket, a real but not billed-in-production Scan), not the
    recurring AWS cost this function exists to avoid.
    """
    bucket_name = os.environ.get("YOBI_HISTORY_BUCKET")
    if not bucket_name:
        result: dict[str, set[str]] = {}
        for video in load_videos():
            result.setdefault(video.creator_id, set()).add(video.video_id)
        return result

    store = S3TrackingManifestStore(bucket_name)
    result: dict[str, set[str]] = {}
    for shard in range(HISTORY_SHARD_COUNT):
        entries, _version = store.read_shard_for_patch(shard)
        for entry in entries:
            result.setdefault(entry.creator_id, set()).add(entry.video_id)
    return result


def _patch_manifest_with_new_videos_if_configured(new_videos: list[Video]) -> None:
    """Add exactly the newly discovered videos to the manifest, one bounded
    read-modify-write per affected shard -- never a full-catalog Scan or a
    full HISTORY_SHARD_COUNT-shard republish (AWS Cost Recovery, third pass).

    Best-effort, same reasoning as _publish_manifest_if_configured's own
    docstring: a failure here means history_worker's next run sees a
    manifest missing today's new videos until a later successful patch
    fixes it -- never a reason to fail discovery, which has already durably
    written these videos to Video Master (upsert_videos, called before this).

    Each affected shard's patch uses `dict.setdefault` (never unconditional
    overwrite) keyed by video_id when merging in the "new" entries: if a
    video_id already exists in that shard by the time this patch actually
    applies (a genuine race -- e.g. an overlapping manual rerun's own
    discovery already added it first), the *existing* entry always wins, so
    a video already tracked (with real, evolved activity_state) can never be
    regressed back to a freshly-discovered "Unknown" placeholder merely
    because two discovery runs both believed it was new.
    """
    bucket_name = os.environ.get("YOBI_HISTORY_BUCKET")
    if not bucket_name or not new_videos:
        return
    store = S3TrackingManifestStore(bucket_name)
    by_shard: dict[int, dict[str, ManifestEntry]] = {}
    for video in new_videos:
        by_shard.setdefault(shard_for_video(video.video_id), {})[video.video_id] = ManifestEntry(
            video_id=video.video_id,
            creator_id=video.creator_id,
            active=True,
            discovered_at=video.discovered_at,
            published_at=video.published_at,
            activity_state=video.activity_state,
            topic=video.topic,
        )

    for shard, new_entries_by_id in by_shard.items():
        def _apply(entries: list[ManifestEntry], new_entries_by_id=new_entries_by_id) -> list[ManifestEntry]:
            merged = {entry.video_id: entry for entry in entries}
            for video_id, entry in new_entries_by_id.items():
                merged.setdefault(video_id, entry)
            return list(merged.values())

        try:
            patch_shard(store, shard, _apply)
        except Exception as exc:
            print(f"Warning: failed to patch tracking manifest shard {shard:02d} ({type(exc).__name__}): {exc}")


def _record_new_video_events_best_effort(
    newly_discovered: list[Video], first_ingestion_creator_ids: set[str], run_time: datetime
) -> None:
    """Record a Roadmap 4.6 notification event for each newly discovered video, except first-ingestion backlog.

    Best-effort: a video is already durably tracked in Video Master by the
    time this runs (the caller always calls upsert_videos first), so a
    failure here means the Roadmap 4.6 notification dispatcher misses one
    run's worth of new-video events — worth a warning, not a reason to fail
    a collection run that otherwise succeeded.
    """
    to_notify = [
        video
        for video in newly_discovered
        if video.creator_id not in first_ingestion_creator_ids or _is_recent(video, run_time)
    ]
    if len(to_notify) < len(newly_discovered):
        print(f"Seeded {len(newly_discovered) - len(to_notify)} first-ingestion backlog video(s) without notifications")
    if not to_notify:
        return
    try:
        record_new_video_events(to_notify)
    except NotificationEventsStoreError as exc:
        print(f"Warning: failed to record notification events for {len(to_notify)} video(s): {exc}")


def _is_recent(video: Video, run_time: datetime) -> bool:
    try:
        published_at = datetime.fromisoformat(video.published_at.replace("Z", "+00:00"))
        return run_time - FIRST_INGESTION_NOTIFY_WINDOW <= published_at <= run_time
    except (ValueError, TypeError):
        return False


def _publish_manifest_if_configured(videos: list[Video]) -> None:
    """Publish the complete catalog only in the configured S3 architecture.

    AWS Cost Recovery (third pass): only main()'s own unscheduled, manual
    heavy-collection path still calls this full-rebuild function daily-shaped
    -- but main() itself has no production schedule at all (see
    terraform/eventbridge.tf; only run_discovery's lighter path is scheduled),
    so this remains correct there without adding any real recurring AWS cost.
    The scheduled `discovery_only` path (run_discovery) now uses
    _patch_manifest_with_new_videos_if_configured instead, a bounded
    incremental patch -- see that function's own docstring.

    Best-effort, same reasoning as _record_new_video_events_best_effort's
    own docstring: a failure here means history_worker's next run sees a
    stale manifest (fixed by the next successful publish), which must never
    abort the existing YouTube statistics collection this function's caller
    is actually responsible for. Catches Exception, not just
    TrackingManifestError: pyarrow's own import (wrapped as
    TrackingManifestError by tracking_manifest._pyarrow) is not the only
    thing that can fail here -- pa.table(...)/parquet.write_table(...) and
    the S3 upload itself can each raise their own unwrapped exception types
    (a pyarrow runtime error, a botocore error, ...), none of which this
    function's caller is responsible for handling either. Deliberately
    Exception, not BaseException: this must never swallow
    KeyboardInterrupt/SystemExit.
    """
    bucket_name = os.environ.get("YOBI_HISTORY_BUCKET")
    if not bucket_name:
        return
    # Last occurrence wins so a just-discovered record replaces an older
    # master copy if the caller supplied both.
    current = {video.video_id: video for video in videos}
    try:
        publish_tracking_manifest(
            list(current.values()),
            S3TrackingManifestStore(bucket_name),
        )
    except Exception as exc:
        print(f"Warning: failed to publish tracking manifest ({type(exc).__name__}): {exc}")


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
            topic=classify_video_topic(item["title"]),
        )
        for item in discovered
    ]
    return [video.video_id for video in videos], videos


if __name__ == "__main__":
    sys.exit(main())
