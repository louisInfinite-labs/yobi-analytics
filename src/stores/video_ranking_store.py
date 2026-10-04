"""S3-only durable storage for the daily per-creator video-ranking RESULT
(video-ranking Phase C).

Mirrors stores.subscriber_ranking_store's own S3 JSON conventions (bucket-
wide client, ClientError NoSuchKey/404 -> None on read, from_environment
reading YOBI_HISTORY_BUCKET) and stores.trending_cache_archive_store's own
"not configured" contract (from_environment returns None rather than
raising, so a caller needs no conditional-import dance of its own).

Deliberately one object per (report date, creator) -- never a separate
object per creator x topic x metric, and (Phase C storage correction) never
a separate row set per metric either: this object holds exactly ONE
canonical row per video (analytics.video_ranking_result.build_video_ranking_
result's own "videos" list), carrying every metric's own anchor view count
on that same row. Topic filtering, metric selection, and ranking/sorting all
happen at READ time (see analytics.video_ranking.rank_video_rows and
api.read_api.get_video_ranking) over this one row set.
"""

from __future__ import annotations

import json
import os
from datetime import date
from typing import Any

from botocore.exceptions import ClientError

from stores.history_bucket import resolve_history_bucket

# Bumped from 1 -- the Phase C storage correction changed the persisted
# shape from four duplicated per-metric row sets to one canonical row per
# video (build_video_ranking_result's own "videos" list). This feature is
# not deployed yet (no production object was ever written under
# schemaVersion 1), so this is a version bump for the repository's own
# convention, not a migration -- no reader needs to handle both shapes.
VIDEO_RANKING_PREFIX = "video-ranking"
VIDEO_RANKING_SCHEMA_VERSION = 2


class VideoRankingStoreError(RuntimeError):
    """Raised when the S3 video-ranking result can't be written or read."""


def video_ranking_key(report_date: date, creator_id: str) -> str:
    """One deterministic S3 key per (report date, creator) -- no shard, no
    per-topic, no per-metric object."""
    return f"{VIDEO_RANKING_PREFIX}/date={report_date.isoformat()}/creator={creator_id}.json"


class S3VideoRankingStore:
    """S3-backed storage for one creator's own-video ranking result per day."""

    def __init__(self, bucket_name: str, *, s3_client=None) -> None:
        if not bucket_name:
            raise ValueError("bucket_name must not be empty")
        if s3_client is None:
            import boto3

            s3_client = boto3.client("s3")
        self.bucket_name = bucket_name
        self.s3_client = s3_client

    @classmethod
    def from_environment(cls, *, s3_client=None) -> "S3VideoRankingStore | None":
        """Return an instance if YOBI_HISTORY_BUCKET is configured, else None."""
        bucket_name = os.environ.get("YOBI_HISTORY_BUCKET")
        if not bucket_name:
            return None
        return cls(bucket_name, s3_client=s3_client)

    @classmethod
    def from_environment_or_default(cls, *, s3_client=None) -> "S3VideoRankingStore":
        """Read-side factory: YOBI_HISTORY_BUCKET when set (override), else the fixed production history bucket.

        Used by the API Lambda, which has no bucket env var. Writers (the ranking reducer) keep the strict
        from_environment() so an unconfigured run never defaults to writing into the production bucket.
        """
        return cls(resolve_history_bucket(), s3_client=s3_client)

    def write_result(self, report_date: date, creator_id: str, payload: dict[str, Any]) -> str:
        """Deterministically replace this (date, creator)'s result -- a
        same-date rebuild simply overwrites the same key, never appending or
        versioning."""
        key = video_ranking_key(report_date, creator_id)
        body = json.dumps({"schemaVersion": VIDEO_RANKING_SCHEMA_VERSION, **payload}).encode("utf-8")
        try:
            self.s3_client.put_object(Bucket=self.bucket_name, Key=key, Body=body, ContentType="application/json")
        except ClientError as exc:
            raise VideoRankingStoreError(f"Failed to write s3://{self.bucket_name}/{key}: {exc}") from exc
        return key

    def read_result(self, report_date: date, creator_id: str) -> dict[str, Any] | None:
        key = video_ranking_key(report_date, creator_id)
        try:
            body = self.s3_client.get_object(Bucket=self.bucket_name, Key=key)["Body"].read()
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "404"}:
                return None
            raise VideoRankingStoreError(f"Failed to read s3://{self.bucket_name}/{key}: {exc}") from exc
        return json.loads(body)
