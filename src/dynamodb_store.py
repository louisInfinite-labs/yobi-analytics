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

This module loads the whole Video Master table via Scan rather than a
targeted GSI query on (activityState, nextCheckAt) — at the current catalog
size (~10^5 videos, small items) a daily full Scan costs a few cents of
on-demand RCU. Roadmap 2.3's "no full-table scan" guidance is a scaling
concern for well beyond this size; a nextCheckAt GSI is a deliberate later
optimization, not implemented here.
"""

from __future__ import annotations

import math
import threading
from datetime import date
from decimal import Decimal
from typing import Any

import boto3
import os
from botocore.config import Config
from botocore.exceptions import ClientError
from snapshot_store import (
    SkippedVideo,
    Snapshot,
    SnapshotRunSummary,
    SnapshotStoreError,
    coerce_view_count,
    validate_daily_collection,
)
from snapshot_store import _summary_to_raw
from snapshot_store import _to_raw as _snapshot_to_raw
from video_master import Video, VideoMasterError
from video_master import _parse_video as _parse_video_raw
from video_master import _to_raw as _video_to_raw

VIDEO_MASTER_TABLE = os.environ.get("YOBI_VIDEO_MASTER_TABLE") or "YobiVideoMaster"
SNAPSHOTS_TABLE = os.environ.get("YOBI_SNAPSHOTS_TABLE") or "YobiSnapshots"
RUN_SUMMARIES_TABLE = os.environ.get("YOBI_RUN_SUMMARIES_TABLE") or "YobiRunSummaries"

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

    max_pool_connections is raised from botocore's own default of 10 so one
    thread's own resource has enough headroom for _SNAPSHOT_FETCH_WORKERS'
    per-thread concurrency (currently sequential per resource, but sized
    with the same margin as before this per-thread split).

    No region_name override: locally this resolves via `aws configure`'s
    saved config, and on Lambda via the execution environment's own region —
    same resolution boto3 always does, deliberately not hardcoded here.
    """
    resource = getattr(_thread_local, "dynamodb_resource", None)
    if resource is None:
        session = boto3.session.Session()
        resource = session.resource("dynamodb", config=Config(max_pool_connections=30))
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
    """Write a day's collection-run completeness summary, refusing to overwrite an existing one."""
    _put_run_summary_exclusive(summary, snapshot_date)
    return f"DynamoDB table {RUN_SUMMARIES_TABLE} (snapshotDate={snapshot_date.isoformat()})"


def save_daily_collection(
    snapshots: list[Snapshot], run_summary: SnapshotRunSummary, snapshot_date: date
) -> tuple[str, str]:
    """Write a day's snapshots and its run summary together as one recoverable pair.

    The run summary's conditional put happens *first*: it's one small item,
    so it's a cheap way to reserve the date and reject a concurrent/duplicate
    run before committing to batch-writing tens of thousands of snapshot
    items. If that batch write then fails partway through — a realistic risk
    given it can take minutes and cross a Lambda timeout or hit throttling —
    the rollback deletes whatever snapshot items *did* get written for this
    date before releasing the run summary reservation. Releasing the
    reservation while partial snapshot items remained would leave stray,
    unowned data behind — a later successful run isn't guaranteed to rewrite
    every one of those same items (e.g. a differently-scoped retry), so
    without this cleanup a video could keep a snapshot from a run that was
    never actually recorded as complete. Without releasing the reservation
    at all, every retry would be rejected by the same exclusivity check with
    no way to ever finish that date.
    """
    expected_date = snapshot_date.isoformat()
    validate_daily_collection(snapshots, run_summary, snapshot_date)

    _put_run_summary_exclusive(run_summary, snapshot_date)

    table = _resource().Table(SNAPSHOTS_TABLE)
    try:
        with table.batch_writer() as batch:
            for snapshot in snapshots:
                batch.put_item(Item=_snapshot_to_raw(snapshot))
    except ClientError as exc:
        cleanup_succeeded = _delete_snapshots_for_date(snapshot_date)
        if not cleanup_succeeded:
            raise SnapshotStoreError(
                f"Failed to write to {SNAPSHOTS_TABLE}: {exc}. Cleanup of the partial write also failed, "
                f"so the {expected_date} run summary reservation was deliberately left in place rather than "
                "released over unconfirmed-clean data — manual cleanup is required before this date can be retried."
            ) from exc
        summary_deleted = _delete_run_summary(snapshot_date)
        if not summary_deleted:
            raise SnapshotStoreError(
                f"Failed to write to {SNAPSHOTS_TABLE}: {exc}. Snapshot cleanup succeeded, but deleting the "
                f"{expected_date} run summary reservation could not be confirmed — manual cleanup is required "
                "before this date can be retried, otherwise every retry will fail against a reservation that "
                "may still exist."
            ) from exc
        raise SnapshotStoreError(f"Failed to write to {SNAPSHOTS_TABLE}: {exc}") from exc

    return (
        f"DynamoDB table {SNAPSHOTS_TABLE} (snapshotDate={expected_date})",
        f"DynamoDB table {RUN_SUMMARIES_TABLE} (snapshotDate={expected_date})",
    )


def _delete_snapshots_for_date(snapshot_date: date) -> bool:
    """Delete every YobiSnapshots item for one date, used to clean up a partial
    write after a failed batch. Returns True if the cleanup completed, False
    if it failed partway — the caller must not release the run summary
    reservation on a False result, or a video could keep a snapshot from a
    run that was never actually recorded as complete (see save_daily_collection).
    No GSI on snapshotDate yet, so this is a filtered Scan (Roadmap 2.3's
    documented "later optimization"), acceptable here since a rollback is an
    exceptional path, not the steady state. ConsistentRead=True so this scan
    cannot miss an item the just-failed batch write already committed — an
    eventually-consistent read could otherwise return True over snapshots
    that are still actually present, letting the caller release the run
    summary reservation too early.
    """
    expected_date = snapshot_date.isoformat()
    table = _resource().Table(SNAPSHOTS_TABLE)
    try:
        keys_to_delete: list[dict] = []
        scan_kwargs = {
            "FilterExpression": "snapshotDate = :d",
            "ProjectionExpression": "videoId, snapshotDate",
            "ExpressionAttributeValues": {":d": expected_date},
            "ConsistentRead": True,
        }
        while True:
            response = table.scan(**scan_kwargs)
            keys_to_delete.extend(
                {"videoId": item["videoId"], "snapshotDate": item["snapshotDate"]} for item in response["Items"]
            )
            if "LastEvaluatedKey" not in response:
                break
            scan_kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]

        with table.batch_writer() as batch:
            for key in keys_to_delete:
                batch.delete_item(Key=key)
        return True
    except ClientError:
        return False


def _delete_run_summary(snapshot_date: date) -> bool:
    """Delete a run summary reservation after a failed snapshot batch write.

    Returns True if the deletion completed, False if it failed — the caller
    must not treat a False result as "reservation gone", or every retry for
    this date will keep failing FileExistsError against a reservation that
    may still be present (see save_daily_collection).
    """
    try:
        _resource().Table(RUN_SUMMARIES_TABLE).delete_item(Key={"snapshotDate": snapshot_date.isoformat()})
        return True
    except ClientError:
        return False


def _put_run_summary_exclusive(summary: SnapshotRunSummary, snapshot_date: date) -> None:
    """Write summary to RUN_SUMMARIES_TABLE, raising FileExistsError if that date is already recorded."""
    expected_date = snapshot_date.isoformat()
    if summary.snapshot_date != expected_date:
        raise SnapshotStoreError(
            f"Snapshot Run Summary snapshotDate {summary.snapshot_date!r} does not match the requested {expected_date}"
        )

    table = _resource().Table(RUN_SUMMARIES_TABLE)
    try:
        table.put_item(
            Item=_summary_to_raw(summary),
            ConditionExpression="attribute_not_exists(snapshotDate)",
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise FileExistsError(
                f"Snapshot run summary for {expected_date} already exists in {RUN_SUMMARIES_TABLE}"
            ) from None
        raise SnapshotStoreError(f"Failed to write run summary to {RUN_SUMMARIES_TABLE}: {exc}") from exc


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
