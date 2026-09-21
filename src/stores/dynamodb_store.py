"""DynamoDB-backed durable storage for Video Master and Snapshots (Roadmap 2.3).

Lambda's /tmp is wiped on cold start, so the JSON-file stores in
video_master.py/snapshot_store.py cannot durably persist scheduler state or
snapshot history in production — that's what this module replaces them with
when YOBI_STORAGE_BACKEND=dynamodb (see main.py). Local development keeps
using the JSON stores unchanged.

Deliberately reuses Video/Snapshot/SkippedVideo/SnapshotRunSummary and their
_parse_video/_to_raw/_summary_to_raw conversion helpers from the JSON stores
rather than duplicating field validation here — a DynamoDB item and a JSON
record are both just a dict of the same camelCase attributes, so the only
DynamoDB-specific step is converting the two velocity floats to/from
Decimal (DynamoDB's Number type has no native float support).

`load_videos()` remains for discovery/master compatibility and still scans
the whole Video Master table. Scheduled daily collection no longer uses it:
workers consume the sharded S3 tracking manifest. `get_videos_by_creator()`
queries the creatorId GSI for the legacy read fallback and returns all pages
so no tracked video is excluded before its actual growth is known.
"""

from __future__ import annotations

import json
import math
import threading
from datetime import date
from decimal import Decimal
from typing import Any

import boto3
import os
from boto3.dynamodb.conditions import Key
from botocore.config import Config
from botocore.exceptions import ClientError
from stores.snapshot_store import (
    SkippedVideo,
    Snapshot,
    SnapshotRunSummary,
    SnapshotStoreError,
    coerce_view_count,
    validate_daily_collection,
)
from stores.snapshot_store import _summary_to_raw
from stores.snapshot_store import _to_raw as _snapshot_to_raw
from tracking.video_master import Video, VideoMasterError
from tracking.video_master import _parse_video as _parse_video_raw
from tracking.video_master import _to_raw as _video_to_raw
from tracking.video_topics import TOPIC_IDS

VIDEO_MASTER_TABLE = os.environ.get("YOBI_VIDEO_MASTER_TABLE") or "YobiVideoMaster"
CREATOR_ID_INDEX = "creatorId-index"
TRENDING_CACHE_TABLE = os.environ.get("YOBI_TRENDING_CACHE_TABLE") or "YobiTrendingCache"
SNAPSHOTS_TABLE = os.environ.get("YOBI_SNAPSHOTS_TABLE") or "YobiSnapshots"
RUN_SUMMARIES_TABLE = os.environ.get("YOBI_RUN_SUMMARIES_TABLE") or "YobiRunSummaries"

# A run summary's `status` attribute, added alongside its existing fields
# (requestedCount/collectedCount/skipped from snapshot_store._summary_to_raw)
# rather than on the shared SnapshotRunSummary dataclass itself -- this is a
# DynamoDB-only recovery concern the local JSON backend has no equivalent
# need for (see save_daily_collection's own docstring).
RUN_SUMMARY_STATUS_IN_PROGRESS = "IN_PROGRESS"
RUN_SUMMARY_STATUS_COMPLETE = "COMPLETE"

# Every row written before this fix has no `status` attribute at all --
# including every genuinely-COMPLETE historical date (2026-08-30 through
# 2026-09-13, each individually confirmed by an actual full-table scan
# during the T2.7 backfill attempt to have exactly as many YobiSnapshots
# rows as its own collectedCount claims). Treating "status missing" as
# retryable in general would let any of those already-correct dates be
# silently reclaimed and overwritten by anything that still calls
# save_daily_collection with an explicit past date (e.g.
# scripts/seed_snapshots_dynamodb.py or scripts/migrate_to_dynamodb.py,
# re-run for any reason) -- the ordinary scheduled/retried collector
# invocation can never target a past date itself (main.py always computes
# its own collection date from "now"), so that risk is narrow, but real.
#
# 2026-09-14 is the one specific date this fix exists to unblock (see its
# own module-level incident notes in save_daily_collection): a Lambda
# timeout killed that day's collection mid-batch-write, so its row is
# genuinely, confirmedly incomplete despite predating this fix too. This
# frozenset is the deliberately narrow, explicit, audited allowlist of
# dates where "status missing" should still mean retryable -- the same
# hardcoded-allowlist pattern already used in
# scripts/backfill_video_master.py's CORRECTED_CHANNEL_IDS, rather than a
# general migration or a broader time-based heuristic. Never grows after
# 2026-09-14 is repaired; never needs entries for anything written after
# this fix deploys, since every new write always sets a real `status`.
KNOWN_INCOMPLETE_LEGACY_DATES = frozenset({"2026-09-14"})

# The two float fields on Video that DynamoDB's Number type requires as
# Decimal rather than Python float (see tracking_schedule.ClassificationResult).
_VELOCITY_FIELDS = ("lastPercentGrowthPerDay", "lastAvgViewsPerDay")

# DynamoDB's Number type has no int/float distinction — boto3's resource API
# deserializes *every* Number attribute as Decimal on read, regardless of
# whether it was written as a Python int or float. These three are always
# whole numbers and must come back as int for _parse_video's int checks.
_INT_FIELDS = ("lastViewCount", "snapshotCount", "quietStreak")


_thread_local = threading.local()


def _resource():
    """Return this thread's own cached boto3 DynamoDB resource, using the ambient AWS credentials/region.

    Boto3 Resource and Session instances are documented as not thread-safe
    (https://docs.aws.amazon.com/boto3/latest/guide/resources.html) and
    should not be shared across threads — unlike the low-level Client,
    which is. read_api.py's _compute_growth_results fans out concurrent
    GetItem calls across threads (its own _SNAPSHOT_FETCH_WORKERS), so a
    single process-wide Resource singleton was the wrong cache key. Caching
    one per thread instead keeps the same benefit a cache exists for at all
    — constructing a fresh `boto3.resource()` per call gets its own
    underlying connection pool, forcing a brand new TLS handshake for every
    single call instead of reusing a warm connection, which is what made a
    real production-scale (~thousands of videos) trending request exceed
    API Gateway's 29-second integration timeout even after parallelizing
    the calls themselves — while giving every thread its own Resource
    instance rather than sharing one.

    max_pool_connections is raised from botocore's own default of 10 to 110
    — comfortably above read_api.py's _SNAPSHOT_FETCH_WORKERS (100) — so a
    Lambda-wide surge of concurrent per-thread resources never has to queue
    on connection-pool exhaustion during a large organization's trending
    request (2026-09-05: a 32-creator organization's own back-catalog alone
    ran into the tens of thousands of videos, which is what pushed the
    worker count up from its original 20).

    No region_name override: locally this resolves via `aws configure`'s
    saved config, and on Lambda via the execution environment's own region —
    same resolution boto3 always does, deliberately not hardcoded here.
    """
    resource = getattr(_thread_local, "dynamodb_resource", None)
    if resource is None:
        session = boto3.session.Session()
        resource = session.resource("dynamodb", config=Config(max_pool_connections=110))
        _thread_local.dynamodb_resource = resource
    return resource


def load_videos() -> list[Video]:
    """Load every video currently in the Tracking Universe from DynamoDB."""
    table = _resource().Table(VIDEO_MASTER_TABLE)
    items: list[dict] = []
    try:
        response = table.scan()
        items.extend(response.get("Items", []))
        while "LastEvaluatedKey" in response:
            response = table.scan(ExclusiveStartKey=response["LastEvaluatedKey"])
            items.extend(response.get("Items", []))
    except ClientError as exc:
        raise VideoMasterError(f"Failed to scan {VIDEO_MASTER_TABLE}: {exc}") from exc
    return [_item_to_video(item) for item in items]


def get_videos_by_creator(creator_id: str) -> list[Video]:
    """Return every video for one creator via the creatorId-index GSI."""
    table = _resource().Table(VIDEO_MASTER_TABLE)
    items: list[dict] = []
    try:
        response = table.query(IndexName=CREATOR_ID_INDEX, KeyConditionExpression=Key("creatorId").eq(creator_id))
        items.extend(response.get("Items", []))
        while "LastEvaluatedKey" in response:
            response = table.query(
                IndexName=CREATOR_ID_INDEX,
                KeyConditionExpression=Key("creatorId").eq(creator_id),
                ExclusiveStartKey=response["LastEvaluatedKey"],
            )
            items.extend(response.get("Items", []))
    except ClientError as exc:
        raise VideoMasterError(f"Failed to query {VIDEO_MASTER_TABLE} by creatorId: {exc}") from exc
    return [_item_to_video(item) for item in items]


class TrendingCacheError(Exception):
    """Raised when YobiTrendingCache can't be read or written."""


def get_cached_trending(cache_key: str) -> dict[str, Any] | None:
    """Return one precomputed trending response by its cache key, or None on a cache miss.

    The stored `payload` attribute is the exact response dict trending_precompute.py
    built for this scope/period/rankingType/reportDate/timeZone combination —
    already ranked, already capped at MAX_LIMIT — serialized as a JSON string
    so Decimal round-tripping is never a concern for arbitrary nested response
    fields the way it is for Video Master's own typed attributes.
    """
    table = _resource().Table(TRENDING_CACHE_TABLE)
    try:
        item = table.get_item(Key={"cacheKey": cache_key}).get("Item")
    except ClientError as exc:
        raise TrendingCacheError(f"Failed to read {TRENDING_CACHE_TABLE}: {exc}") from exc
    return json.loads(item["payload"]) if item else None


def put_cached_trending(cache_key: str, payload: dict[str, Any], *, computed_at: str) -> None:
    """Write (or overwrite) one precomputed trending response under cache_key."""
    table = _resource().Table(TRENDING_CACHE_TABLE)
    try:
        table.put_item(Item={"cacheKey": cache_key, "payload": json.dumps(payload), "computedAt": computed_at})
    except ClientError as exc:
        raise TrendingCacheError(f"Failed to write {TRENDING_CACHE_TABLE}: {exc}") from exc


def get_video(video_id: str) -> Video | None:
    """Return one video by ID, or None if it isn't in the Tracking Universe.

    A direct GetItem on the table's own videoId key, so no full-table Scan
    is needed for this single-video access pattern (Roadmap 3.4's Read API).
    """
    table = _resource().Table(VIDEO_MASTER_TABLE)
    try:
        item = table.get_item(Key={"videoId": video_id}).get("Item")
    except ClientError as exc:
        raise VideoMasterError(f"Failed to read {VIDEO_MASTER_TABLE}: {exc}") from exc
    return _item_to_video(item) if item else None


def upsert_videos(videos: list[Video]) -> None:
    """Insert or update videos into the DynamoDB Video Master table."""
    if not videos:
        return
    table = _resource().Table(VIDEO_MASTER_TABLE)
    try:
        with table.batch_writer() as batch:
            for video in videos:
                batch.put_item(Item=_video_to_item(video))
    except ClientError as exc:
        raise VideoMasterError(f"Failed to write to {VIDEO_MASTER_TABLE}: {exc}") from exc


def scan_video_topic_items() -> list[dict[str, Any]]:
    """Scan Video Master for each item's videoId/title/topic only (an ops scan, not a request path)."""
    table = _resource().Table(VIDEO_MASTER_TABLE)
    scan_kwargs = {
        "ProjectionExpression": "#videoId, #title, #topic",
        "ExpressionAttributeNames": {"#videoId": "videoId", "#title": "title", "#topic": "topic"},
    }
    items: list[dict[str, Any]] = []
    try:
        response = table.scan(**scan_kwargs)
        items.extend(response.get("Items", []))
        while "LastEvaluatedKey" in response:
            response = table.scan(ExclusiveStartKey=response["LastEvaluatedKey"], **scan_kwargs)
            items.extend(response.get("Items", []))
    except ClientError as exc:
        raise VideoMasterError(f"Failed to scan {VIDEO_MASTER_TABLE}: {exc}") from exc
    return items


def set_video_topic(video_id: str, topic: str, *, overwrite: bool) -> bool:
    """Set only the `topic` attribute of an existing video, leaving every other field untouched.

    A targeted UpdateItem rather than upsert_videos' whole-item put, so a topic
    write can never clobber scheduler state another writer just updated.
    Returns False when the condition rejects the write: the video no longer
    exists, or (overwrite=False) it already has a topic.
    """
    if topic not in TOPIC_IDS:
        raise ValueError(f"Unknown topic id: {topic!r}")
    condition = "attribute_exists(videoId)" if overwrite else "attribute_exists(videoId) AND attribute_not_exists(#topic)"
    table = _resource().Table(VIDEO_MASTER_TABLE)
    try:
        table.update_item(
            Key={"videoId": video_id},
            UpdateExpression="SET #topic = :topic",
            ConditionExpression=condition,
            ExpressionAttributeNames={"#topic": "topic"},
            ExpressionAttributeValues={":topic": topic},
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        raise VideoMasterError(f"Failed to set topic in {VIDEO_MASTER_TABLE}: {exc}") from exc
    return True


def get_snapshot(video_id: str, snapshot_date: date) -> Snapshot | None:
    """Return one video's snapshot for a specific date, or None if no such item exists.

    Roadmap 3.1: a caller must never substitute a nearby date's snapshot for
    a missing one, so this returns None rather than querying a range — the
    caller decides what a missing result means (pending vs. not available).
    A direct GetItem on the table's own (videoId, snapshotDate) key, so no
    GSI or scan is needed for this access pattern.
    """
    table = _resource().Table(SNAPSHOTS_TABLE)
    try:
        item = table.get_item(Key={"videoId": video_id, "snapshotDate": snapshot_date.isoformat()}).get("Item")
    except ClientError as exc:
        raise SnapshotStoreError(f"Failed to read {SNAPSHOTS_TABLE}: {exc}") from exc
    return _item_to_snapshot(item) if item else None


def save_run_summary(summary: SnapshotRunSummary, snapshot_date: date) -> str:
    """Write a day's collection-run completeness summary, refusing to overwrite
    an already-COMPLETE date. Used for the zero-snapshot bootstrap path (every
    due video failed, or none were due) where there is no bulk snapshot write
    to protect against a mid-write timeout — this date is complete the moment
    this single write succeeds, so it claims and completes back to back."""
    _claim_run_summary(summary, snapshot_date)
    _mark_run_summary_complete(snapshot_date)
    return f"DynamoDB table {RUN_SUMMARIES_TABLE} (snapshotDate={snapshot_date.isoformat()})"


def save_daily_collection(
    snapshots: list[Snapshot], run_summary: SnapshotRunSummary, snapshot_date: date
) -> tuple[str, str]:
    """Write a day's snapshots and its run summary together as one recoverable pair.

    Two separate run-summary writes bracket the bulk snapshot write, rather
    than one write moved to either end — a single end-of-day write would lose
    the cheap early exclusivity claim that rejects a concurrent/duplicate run
    before tens of thousands of snapshot items get written; a single
    beginning-of-day write (the old design) let that same claim be
    mistaken for *completion*, which is the actual bug this replaces:

      1. `_claim_run_summary` marks this date IN_PROGRESS. This is a claim,
         not a completion record — see its own docstring for exactly which
         prior states it will and won't let a caller re-claim.
      2. Every snapshot in `snapshots` is written via `batch_writer()`,
         keyed by (videoId, snapshotDate) — replaying the *complete* list
         here is always safe: DynamoDB's PutItem overwrite on that key means
         a second full write of an already-written item is a no-op, and a
         previously-missing item simply gets written for the first time.
         Nothing is deleted here on failure (a hard Lambda timeout during
         this step is not a catchable Python exception — no cleanup code
         could ever run for that case anyway): a retry that calls this
         function again with the same full `snapshots` list — including one
         freshly recomputed from that retry's own collection run, which may
         legitimately differ slightly from the interrupted attempt's list —
         reconciles whatever partial state exists into one internally
         consistent set of rows, reflecting whichever attempt actually
         finishes. `except ClientError` still exists so a batch_writer
         failure (e.g. it exhausts its own UnprocessedItems retries) raises
         a typed error here instead of an unwrapped ClientError — the
         IN_PROGRESS claim from step 1 is deliberately left exactly as it
         is; leaving it in place is what a future retry needs.
      3. Only once every item from step 2 has actually been written does
         `_mark_run_summary_complete` transition the row to COMPLETE — a
         date is never considered done just because a row for it exists.
    """
    expected_date = snapshot_date.isoformat()
    validate_daily_collection(snapshots, run_summary, snapshot_date)

    _claim_run_summary(run_summary, snapshot_date)

    table = _resource().Table(SNAPSHOTS_TABLE)
    try:
        with table.batch_writer() as batch:
            for snapshot in snapshots:
                batch.put_item(Item=_snapshot_to_raw(snapshot))
    except ClientError as exc:
        raise SnapshotStoreError(f"Failed to write to {SNAPSHOTS_TABLE}: {exc}") from exc

    _mark_run_summary_complete(snapshot_date)

    return (
        f"DynamoDB table {SNAPSHOTS_TABLE} (snapshotDate={expected_date})",
        f"DynamoDB table {RUN_SUMMARIES_TABLE} (snapshotDate={expected_date})",
    )


def _claim_run_summary(summary: SnapshotRunSummary, snapshot_date: date) -> None:
    """Claim snapshot_date for collection, marking it IN_PROGRESS.

    Raises FileExistsError when this date is not safely claimable:
      - COMPLETE: a finished day must never be silently recollected.
      - missing `status` entirely, UNLESS this date is in
        KNOWN_INCOMPLETE_LEGACY_DATES: a pre-this-fix row with no status is
        assumed COMPLETE by default (see that constant's own docstring for
        why treating every such row as retryable would be unsafely broad),
        with a narrow, explicit, audited exception for the one date actually
        confirmed incomplete.

    Allowed through (not rejected):
      - IN_PROGRESS: a still-running attempt, or — the production incident
        this exists to unblock — one a hard Lambda timeout killed mid-write
        with no chance to react. This function cannot tell those two apart:
        an attempt that is *actually* still running and a second, genuinely
        concurrent caller could both pass this check and both proceed to
        write. That race is deliberately accepted rather than closed here,
        the same way execution_lock.py's own docstring accepts the
        equivalent race for the newer S3 history pipeline's per-shard
        locking — closing it needs a real lease/owner-token protocol, more
        machinery than this soon-retired legacy path warrants. This is a
        real, not merely theoretical, risk: two overlapping invocations can
        each persist a genuinely different snapshot list for the same date
        (e.g. a video discovered in between their two attempts), so the
        final collectedCount on whichever invocation's own claim write
        happened to land last is not guaranteed to equal the true final
        unique row count in YobiSnapshots afterward, and one invocation can
        mark the date COMPLETE while another is still mid-write for it. The
        cost is bad bookkeeping metadata and a misleading COMPLETE window,
        never fabricated view-count data — every write still lands at the
        real (videoId, snapshotDate) key with real YouTube API data.
      - missing `status`, when this date IS in KNOWN_INCOMPLETE_LEGACY_DATES.
      - no row at all: the normal first-ever attempt for this date.

    Always overwrites the row's descriptive fields (requestedCount/
    collectedCount/skipped) with *this* attempt's own values — whichever
    attempt actually reaches _mark_run_summary_complete is the one whose
    numbers end up authoritative, never a stale mix of an earlier
    interrupted attempt's counts and a later one's data.
    """
    expected_date = snapshot_date.isoformat()
    if summary.snapshot_date != expected_date:
        raise SnapshotStoreError(
            f"Snapshot Run Summary snapshotDate {summary.snapshot_date!r} does not match the requested {expected_date}"
        )

    item = _summary_to_raw(summary)
    item["status"] = RUN_SUMMARY_STATUS_IN_PROGRESS
    condition = "attribute_not_exists(snapshotDate) OR #status = :in_progress"
    if expected_date in KNOWN_INCOMPLETE_LEGACY_DATES:
        condition += " OR attribute_not_exists(#status)"

    table = _resource().Table(RUN_SUMMARIES_TABLE)
    try:
        table.put_item(
            Item=item,
            ConditionExpression=condition,
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":in_progress": RUN_SUMMARY_STATUS_IN_PROGRESS},
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise FileExistsError(
                f"Snapshot run summary for {expected_date} already exists in {RUN_SUMMARIES_TABLE} and is complete"
            ) from None
        raise SnapshotStoreError(f"Failed to write run summary to {RUN_SUMMARIES_TABLE}: {exc}") from exc


def _mark_run_summary_complete(snapshot_date: date) -> None:
    """Transition snapshot_date's run summary from IN_PROGRESS to COMPLETE.

    Called only after every snapshot item has actually been written — this
    is the sole thing that makes a date "done" for _claim_run_summary's own
    re-claim check. Unconditional (no ownerToken to check against, matching
    the accepted race documented on _claim_run_summary): two concurrent
    completions of the same date both set the same COMPLETE value, which is
    harmless.
    """
    table = _resource().Table(RUN_SUMMARIES_TABLE)
    try:
        table.update_item(
            Key={"snapshotDate": snapshot_date.isoformat()},
            UpdateExpression="SET #status = :complete",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":complete": RUN_SUMMARY_STATUS_COMPLETE},
        )
    except ClientError as exc:
        raise SnapshotStoreError(
            f"Failed to mark {snapshot_date.isoformat()} complete in {RUN_SUMMARIES_TABLE}: {exc}"
        ) from exc


def _video_to_item(video: Video) -> dict[str, Any]:
    """Convert a Video into a DynamoDB item, Decimal-izing its velocity floats.

    Mirrors video_master._optional_float's math.isfinite() check on the read
    side: Video has no __post_init__ validation of its own, so a NaN/Infinity
    value reaching here would otherwise build a non-finite Decimal that
    boto3's DynamoDB serializer rejects with a raw TypeError — uncaught by
    the `except ClientError` in upsert_videos, unlike every other write-path
    failure. Not reachable via current callers, but enforced at this boundary
    regardless, rather than trusted to remain true by construction elsewhere.
    """
    raw = _video_to_raw(video)
    for field in _VELOCITY_FIELDS:
        if raw[field] is not None:
            if not math.isfinite(raw[field]):
                raise VideoMasterError(f"Video {video.video_id!r} has non-finite {field!r}: {raw[field]!r}")
            raw[field] = Decimal(str(raw[field]))
    return raw


def _item_to_snapshot(item: dict[str, Any]) -> Snapshot:
    """Convert a DynamoDB Snapshots item back into a Snapshot, restoring int from Decimal."""
    raw = dict(item)
    return Snapshot(
        snapshot_date=raw["snapshotDate"],
        observed_at=raw["observedAt"],
        creator_id=raw["creatorId"],
        video_id=raw["videoId"],
        title=raw["title"],
        published_at=raw["publishedAt"],
        view_count=coerce_view_count(raw["viewCount"], video_id=raw.get("videoId", "<unknown>")),
        organization=raw["organization"],
    )


def _item_to_video(item: dict[str, Any]) -> Video:
    """Convert a DynamoDB item back into a Video, restoring int/float from Decimal."""
    raw = dict(item)
    for field in _VELOCITY_FIELDS:
        if isinstance(raw.get(field), Decimal):
            raw[field] = float(raw[field])
    for field in _INT_FIELDS:
        if isinstance(raw.get(field), Decimal):
            raw[field] = int(raw[field])
    return _parse_video_raw(raw)
