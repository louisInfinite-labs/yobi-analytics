"""One-time graduated-creator historical repair: make every graduated creator's catalog and Home read model complete.

Graduated creators stay selectable as an Oshi, so each one needs a readable Home/ranking dataset. Their automatic
new-video discovery is (and stays) disabled, so a creator whose back catalog was never discovered -- or whose channel
has an undiscovered back catalog -- ends up with no manifest entries and no ranking object (the API answers
RANKING_NOT_READY). This script repairs exactly that, once, as an explicit maintenance operation.

Per graduated creator (derived from src/creators.json: lifecycleStage "graduated" and channelType "member"):
  1. discover the channel's whole public upload history (YouTube uploads playlist);
  2. fetch the CURRENT public stats of anything not yet in VideoMaster (also gives contentType/liveStatus);
  3. insert the missing, still-available videos into VideoMaster (YobiVideoMaster) -- nothing existing is rewritten;
  4. add any VideoMaster video that is missing from the S3 tracking manifest, plus the new ones (existing entries win);
  5. write today's per-creator video-ranking object: the creator's existing object (if any) plus the newly added
     videos with their current view count as the baseline.

A creator whose official uploads source is unavailable (the channel or its uploads playlist is gone upstream) is
reported as SOURCE UNAVAILABLE and left completely untouched: no empty catalog is invented, no other source is
tried, and the rest of the run carries on. (The API answers those creators with a 404 HISTORICAL_DATA_UNAVAILABLE.)

What this deliberately does NOT do:
- no notifications: this module never imports notification_events_store / notification_dispatch, so a backfilled
  video can never be announced as new;
- no fabricated history: it writes no history snapshot rows and no anchors. A newly added video's baseline is its
  current view count; the ordinary history pipeline records real daily history from its next run (the new videos are
  "Unknown" activity state, which is always due);
- graduated discovery stays disabled: creators.json, Terraform and the scheduler are untouched, and the collector
  still skips `discovery_enabled=false` creators;
- no deletes, and no overwrite of an existing VideoMaster/manifest entry or of existing video rows.

Idempotent: a second run finds nothing missing and writes nothing. Defaults to a dry run (reads only, prints the
plan); pass --execute to write. Needs real credentials and, like the other write-side backfills, an explicit
YOBI_STORAGE_BACKEND=dynamodb and YOBI_HISTORY_BUCKET (it refuses to guess a production target).

Usage:
    .venv\\Scripts\\python.exe scripts/backfill/backfill_graduated_history.py            # dry run (also the audit)
    .venv\\Scripts\\python.exe scripts/backfill/backfill_graduated_history.py --execute  # write
    ... --creator-id mano_aloe                                                           # one creator only
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))

from analytics.video_ranking import GROWTH_METRICS  # noqa: E402
from api.read_api import LATEST_REPORT_LOOKBACK_DAYS  # noqa: E402
from collection.youtube_client import YouTubeAPIError, build_youtube_client, get_video_statistics  # noqa: E402
from ops.config import MissingAPIKeyError, get_api_key  # noqa: E402
from stores.history_store import HISTORY_SHARD_COUNT, shard_for_video  # noqa: E402
from stores.video_ranking_store import S3VideoRankingStore  # noqa: E402
from tracking.creator_master import Creator, load_creators  # noqa: E402
from tracking.tracking_manifest import ManifestEntry, S3TrackingManifestStore, patch_shard  # noqa: E402
from tracking.video_discovery import discover_all_videos, get_uploads_playlist_id  # noqa: E402
from tracking.video_master import Video  # noqa: E402
from tracking.video_topics import classify_video_topic  # noqa: E402

_TIME_ZONE = ZoneInfo("Asia/Tokyo")
_NO_CHANNEL_PREFIX = "No channel found"
_NOT_FOUND_MARKER = "(status 404)"


class UnauthorizedCreatorError(ValueError):
    """Raised when asked to process a creator that is not a graduated individual creator."""


@dataclass
class CreatorPlan:
    """What one creator's repair would do (computed read-only)."""

    creator_id: str
    source_available: bool
    discovered: int = 0
    unavailable: int = 0
    already_in_master: int = 0
    stale_in_master: list[str] = field(default_factory=list)
    new_videos: list[Video] = field(default_factory=list)
    manifest_missing_videos: list[Video] = field(default_factory=list)
    baseline_rows: list[dict[str, Any]] = field(default_factory=list)
    ranking_action: str = "none"  # "none" | "write-merged"
    ranking_payload: dict[str, Any] | None = None


def graduated_creators(creators: list[Creator], only: set[str] | None = None) -> list[Creator]:
    """The creators this script may touch: graduated individual creators only. An explicit request for anyone else
    is refused up front, before any API call or storage access."""
    eligible = {c.creator_id: c for c in creators if c.lifecycle_stage == "graduated" and c.channel_type == "member"}
    if only:
        refused = sorted(only - eligible.keys())
        if refused:
            raise UnauthorizedCreatorError(f"not graduated individual creators, refusing: {refused}")
        return [eligible[creator_id] for creator_id in sorted(only)]
    return [eligible[creator_id] for creator_id in sorted(eligible)]


def _discover_channel(youtube: Any, creator: Creator) -> tuple[list[dict], bool]:
    """(uploads, source_available). The official uploads source is "unavailable" when the channel no longer exists or
    its uploads playlist answers 404 (playlistNotFound) -- that proves nothing about whether videos ever existed, so
    it is NOT an empty catalog: the caller leaves the creator untouched. Any other API failure (quota, network) is
    raised, naming the creator, so nothing is half-planned."""
    try:
        playlist_id = get_uploads_playlist_id(youtube, creator.youtube_channel_id)
        return discover_all_videos(youtube, playlist_id), True
    except YouTubeAPIError as exc:
        if str(exc).startswith(_NO_CHANNEL_PREFIX) or _NOT_FOUND_MARKER in str(exc):
            return [], False
        raise YouTubeAPIError(f"{creator.creator_id}: {exc}") from exc


def manifest_ids_by_creator(manifest_store: Any) -> dict[str, set[str]]:
    """Every video id currently in the S3 tracking manifest, grouped by creator (a fixed 16-shard read)."""
    result: dict[str, set[str]] = {}
    for shard in range(HISTORY_SHARD_COUNT):
        entries, _version = manifest_store.read_shard_for_patch(shard)
        for entry in entries:
            result.setdefault(entry.creator_id, set()).add(entry.video_id)
    return result


def _ranking_row(video: Video, view_count: int | None) -> dict[str, Any]:
    """One video-ranking row in the persisted shape (see analytics.video_ranking_result): current view count only,
    every growth anchor None -- no historical value is invented."""
    row: dict[str, Any] = {
        "videoId": video.video_id,
        "creatorId": video.creator_id,
        "topic": video.topic,
        "contentType": video.content_type,
        "liveStatus": video.live_status,
        "currentViewCount": view_count,
        "title": video.title,
        "thumbnailUrl": video.thumbnail_url,
        "publishedAt": video.published_at,
        "discoveredAt": video.discovered_at,
    }
    for period in GROWTH_METRICS:
        row[f"anchor{period}ViewCount"] = None
    return row


def _latest_existing_result(ranking_store: Any, today: date, creator_id: str) -> tuple[dict[str, Any] | None, date | None]:
    """The newest stored result inside the read API's own lookback window (same window the API searches)."""
    for offset in range(LATEST_REPORT_LOOKBACK_DAYS):
        candidate = today - timedelta(days=offset)
        result = ranking_store.read_result(candidate, creator_id)
        if result is not None:
            return result, candidate
    return None, None


def plan_creator(
    *,
    youtube: Any,
    creator: Creator,
    master_videos: list[Video],
    manifest_ids: set[str],
    ranking_store: Any,
    today: date,
    now_iso: str,
    generated_at: str,
) -> CreatorPlan:
    """Compute (read-only) what repairing this creator involves."""
    discovered, source_available = _discover_channel(youtube, creator)
    plan = CreatorPlan(creator_id=creator.creator_id, source_available=source_available, discovered=len(discovered))
    if not source_available:
        return plan  # source unavailable: nothing is planned, nothing is written, nothing is invented

    master_by_id = {video.video_id: video for video in master_videos}
    plan.already_in_master = len([item for item in discovered if item["videoId"] in master_by_id])
    discovered_ids = {item["videoId"] for item in discovered}
    plan.stale_in_master = sorted(set(master_by_id) - discovered_ids)

    # Current public stats for what we do not hold yet: tells us which are still available (the only ones worth
    # tracking), their contentType/liveStatus, and the baseline view count.
    to_check = [item for item in discovered if item["videoId"] not in master_by_id]
    stats, _skip_reasons = get_video_statistics(youtube, [item["videoId"] for item in to_check])
    stats_by_id = {entry["videoId"]: entry for entry in stats}
    plan.unavailable = len(to_check) - len(stats_by_id)

    for item in to_check:
        stat = stats_by_id.get(item["videoId"])
        if stat is None:
            continue  # private/deleted/otherwise unavailable: not source-available, not tracked
        plan.new_videos.append(
            Video(
                video_id=item["videoId"],
                creator_id=creator.creator_id,
                title=item["title"],
                published_at=item["publishedAt"],
                thumbnail_url=item.get("thumbnailUrl"),
                discovered_at=now_iso,
                topic=classify_video_topic(item["title"]),
                content_type=stat.get("contentType"),
                live_status=stat.get("liveStatus"),
            )
        )
    view_by_id = {entry["videoId"]: entry["viewCount"] for entry in stats}

    plan.manifest_missing_videos = [video for video in master_videos if video.video_id not in manifest_ids]

    existing, _existing_date = _latest_existing_result(ranking_store, today, creator.creator_id)
    existing_videos = list(existing["videos"]) if existing else []
    existing_ids = {row["videoId"] for row in existing_videos}

    # Baseline rows: every newly added video; and, only when this creator has no stored result at all, the videos
    # already in VideoMaster too (their current stats are fetched below).
    baseline_videos = list(plan.new_videos)
    if existing is None and master_videos:
        baseline_videos.extend(master_videos)
        extra_ids = [video.video_id for video in master_videos if video.video_id not in view_by_id]
        extra_stats, _ = get_video_statistics(youtube, extra_ids)
        view_by_id.update({entry["videoId"]: entry["viewCount"] for entry in extra_stats})
    plan.baseline_rows = [
        _ranking_row(video, view_by_id.get(video.video_id))
        for video in baseline_videos
        if video.video_id not in existing_ids and video.video_id in view_by_id
    ]

    merged = existing_videos + plan.baseline_rows
    if plan.baseline_rows:
        plan.ranking_action = "write-merged"
    if plan.ranking_action != "none":
        plan.ranking_payload = {
            "reportDate": today.isoformat(),
            "creatorId": creator.creator_id,
            "generatedAt": generated_at,
            "videos": merged,
        }
    return plan


def _manifest_entry(video: Video) -> ManifestEntry:
    return ManifestEntry(
        video_id=video.video_id,
        creator_id=video.creator_id,
        active=True,
        discovered_at=video.discovered_at,
        published_at=video.published_at,
        activity_state=video.activity_state,
        topic=video.topic,
        title=video.title,
        thumbnail_url=video.thumbnail_url,
        content_type=video.content_type,
        live_status=video.live_status,
    )


def patch_manifest(manifest_store: Any, videos: list[Video]) -> int:
    """Add the given videos to the manifest, one bounded read-modify-write per shard. An entry already present
    always wins (never regressed). Raises on failure -- unlike the collector's best-effort patch, a maintenance run
    must not report success it did not achieve."""
    by_shard: dict[int, dict[str, ManifestEntry]] = {}
    for video in videos:
        by_shard.setdefault(shard_for_video(video.video_id), {})[video.video_id] = _manifest_entry(video)
    for shard, new_by_id in by_shard.items():

        def _apply(entries: list[ManifestEntry], new_by_id: dict[str, ManifestEntry] = new_by_id) -> list[ManifestEntry]:
            merged = {entry.video_id: entry for entry in entries}
            for video_id, entry in new_by_id.items():
                merged.setdefault(video_id, entry)
            return list(merged.values())

        patch_shard(manifest_store, shard, _apply)
    return len(videos)


def apply_plan(
    plan: CreatorPlan, *, upsert_videos: Any, manifest_store: Any, ranking_store: Any, today: date
) -> None:
    """Write one creator's plan. Order matters: VideoMaster first (source of truth), then the manifest, then the
    ranking object -- so an interruption leaves a state a re-run simply completes."""
    if plan.new_videos:
        upsert_videos(plan.new_videos)
    to_manifest = [*plan.new_videos, *plan.manifest_missing_videos]
    if to_manifest:
        patch_manifest(manifest_store, to_manifest)
    if plan.ranking_action != "none" and plan.ranking_payload is not None:
        ranking_store.write_result(today, plan.creator_id, plan.ranking_payload)


def run(
    *,
    youtube: Any,
    creators: list[Creator],
    load_master_videos: Any,
    upsert_videos: Any,
    manifest_store: Any,
    ranking_store: Any,
    execute: bool,
    now: datetime | None = None,
) -> list[CreatorPlan]:
    """Plan every creator first (read-only, so an API failure writes nothing), then -- only with execute -- apply."""
    now = now or datetime.now(_TIME_ZONE)
    today = now.astimezone(_TIME_ZONE).date()
    now_iso = now.astimezone(timezone.utc).isoformat()
    manifest_ids = manifest_ids_by_creator(manifest_store)
    plans = [
        plan_creator(
            youtube=youtube,
            creator=creator,
            master_videos=load_master_videos(creator.creator_id),
            manifest_ids=manifest_ids.get(creator.creator_id, set()),
            ranking_store=ranking_store,
            today=today,
            now_iso=now_iso,
            generated_at=now.isoformat(),
        )
        for creator in creators
    ]
    if execute:
        for plan in plans:
            apply_plan(plan, upsert_videos=upsert_videos, manifest_store=manifest_store, ranking_store=ranking_store, today=today)
    return plans


def plan_report(plans: list[CreatorPlan], *, execute: bool, generated_at: str) -> dict[str, Any]:
    """A machine-readable record of exactly what a run touched (or would touch), for audit and manual rollback."""
    return {
        "generatedAt": generated_at,
        "executed": execute,
        "creators": [
            {
                "creatorId": plan.creator_id,
                "sourceAvailable": plan.source_available,
                "videosFoundUpstream": plan.discovered,
                "unavailableNotTracked": plan.unavailable,
                "staleInMasterNotRemoved": plan.stale_in_master,
                "videoMasterInserted": [video.video_id for video in plan.new_videos],
                "manifestAdded": [video.video_id for video in [*plan.new_videos, *plan.manifest_missing_videos]],
                "rankingAction": plan.ranking_action,
                "rankingVideosWritten": len(plan.ranking_payload["videos"]) if plan.ranking_payload else 0,
            }
            for plan in plans
        ],
    }


def _print_plans(plans: list[CreatorPlan], *, execute: bool) -> None:
    verb = "inserted" if execute else "would insert"
    header = f"{'creator':16} {'source':8} {'found':>6} {'inMaster':>9} {verb:>13} {'unavail':>8} {'stale':>6} {'->manifest':>10}  ranking"
    print(header)
    for plan in plans:
        print(
            f"{plan.creator_id:16} {'yes' if plan.source_available else 'NO-SRC':8} {plan.discovered:>6} {plan.already_in_master:>9} "
            f"{len(plan.new_videos):>13} {plan.unavailable:>8} {len(plan.stale_in_master):>6} "
            f"{len(plan.new_videos) + len(plan.manifest_missing_videos):>10}  {plan.ranking_action}"
        )
    print(
        f"\nTOTAL found={sum(p.discovered for p in plans)} would-insert={sum(len(p.new_videos) for p in plans)} "
        f"unavailable={sum(p.unavailable for p in plans)}"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--creator-id", action="append", help="Only this graduated creator (repeatable). Default: all.")
    parser.add_argument("--execute", action="store_true", help="Actually write. Without it, reads only (dry run).")
    args = parser.parse_args(argv)

    if os.environ.get("YOBI_STORAGE_BACKEND") != "dynamodb" or not os.environ.get("YOBI_HISTORY_BUCKET"):
        print("Error: set YOBI_STORAGE_BACKEND=dynamodb and YOBI_HISTORY_BUCKET explicitly; refusing to guess a target.")
        return 1
    try:
        creators = graduated_creators(load_creators(), set(args.creator_id) if args.creator_id else None)
        api_key = get_api_key()
    except (UnauthorizedCreatorError, MissingAPIKeyError) as exc:
        print(f"Error: {exc}")
        return 1

    from stores.dynamodb_store import get_videos_by_creator, upsert_videos

    bucket = os.environ["YOBI_HISTORY_BUCKET"]
    print(f"=== Graduated history repair -- {'EXECUTE (writing)' if args.execute else 'DRY RUN (no writes)'} ===\n")
    try:
        plans = run(
            youtube=build_youtube_client(api_key),
            creators=creators,
            load_master_videos=get_videos_by_creator,
            upsert_videos=upsert_videos,
            manifest_store=S3TrackingManifestStore(bucket),
            ranking_store=S3VideoRankingStore(bucket),
            execute=args.execute,
        )
    except YouTubeAPIError as exc:
        print(f"Error: {exc} -- nothing was written." if not args.execute else f"Error: {exc}")
        return 1
    _print_plans(plans, execute=args.execute)
    stamp = datetime.now(_TIME_ZONE)
    report_path = f"graduated_backfill_{'execute' if args.execute else 'dryrun'}_{stamp:%Y%m%dT%H%M%S}.json"
    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump(plan_report(plans, execute=args.execute, generated_at=stamp.isoformat()), handle, ensure_ascii=False, indent=2)
    print(f"Report written to {report_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
