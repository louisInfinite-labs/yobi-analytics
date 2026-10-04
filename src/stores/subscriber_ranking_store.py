"""S3-only durable storage for the daily subscriber-leaderboard RESULT
(ranking-simplification, R4).

Mirrors stores.trending_cache_archive_store's own S3 JSON conventions
(bucket-wide client, ClientError NoSuchKey/404 -> None on read,
from_environment reading YOBI_HISTORY_BUCKET) and
stores.ranking_partial_store's own `date=YYYY-MM-DD` key-segment and
schemaVersion field, applied to a single whole-roster object per report date
rather than one object per shard -- there is no sharding dimension here, the
same reasoning stores.subscriber_history_store already gives for R1's own
daily snapshot object.

Deliberately S3-only: this result is never written to YobiTrendingCache or
any DynamoDB table (R4's own explicit scope), avoiding the write/storage
amplification the wider ranking-simplification redesign exists to remove.
"""

from __future__ import annotations

import json
import os
from datetime import date
from typing import Any

from botocore.exceptions import ClientError

from stores.history_bucket import resolve_history_bucket

SUBSCRIBER_RANKING_PREFIX = "subscriber-ranking"
SUBSCRIBER_RANKING_SCHEMA_VERSION = 1


class SubscriberRankingStoreError(RuntimeError):
    """Raised when the S3 subscriber-ranking result can't be written or read."""


def subscriber_ranking_key(report_date: date) -> str:
    """One deterministic S3 key per report date -- no shard, no per-metric,
    no per-organization, no per-creator object."""
    return f"{SUBSCRIBER_RANKING_PREFIX}/date={report_date.isoformat()}.json"


class S3SubscriberRankingStore:
    """S3-backed storage for one whole-roster subscriber-ranking result per day."""

    def __init__(self, bucket_name: str, *, s3_client=None) -> None:
        if not bucket_name:
            raise ValueError("bucket_name must not be empty")
        if s3_client is None:
            import boto3

            s3_client = boto3.client("s3")
        self.bucket_name = bucket_name
        self.s3_client = s3_client

    @classmethod
    def from_environment(cls, *, s3_client=None) -> "S3SubscriberRankingStore | None":
        """Return an instance if YOBI_HISTORY_BUCKET is configured, else None
        -- this method previously raised instead, which meant an
        unconfigured environment surfaced as an unhandled 500 rather than
        the same RankingNotReadyError/503 every other cache-only endpoint in
        read_api.py already produces for "not yet computed")."""
        bucket_name = os.environ.get("YOBI_HISTORY_BUCKET")
        if not bucket_name:
            return None
        return cls(bucket_name, s3_client=s3_client)

    @classmethod
    def from_environment_or_default(cls, *, s3_client=None) -> "S3SubscriberRankingStore":
        """Read-side factory: YOBI_HISTORY_BUCKET when set (override), else the fixed production history bucket.

        Used by the API Lambda, which has no bucket env var. Writers keep the strict from_environment() (or an
        explicit bucket) so an unconfigured run never defaults to writing into the production bucket.
        """
        return cls(resolve_history_bucket(), s3_client=s3_client)

    def write_result(self, report_date: date, payload: dict[str, Any]) -> str:
        """Deterministically replace this date's result -- a same-date rebuild
        (e.g. after R3 repairs a partial subscriber-history snapshot) simply
        overwrites the same key, never appending or versioning; there is no
        "result exists -> skip forever" check here at all, unlike R3's own
        source-snapshot repair logic -- see this module's own docstring for
        why staleness safety, not write-avoidance, is what matters here."""
        key = subscriber_ranking_key(report_date)
        body = json.dumps({"schemaVersion": SUBSCRIBER_RANKING_SCHEMA_VERSION, **payload}).encode("utf-8")
        try:
            self.s3_client.put_object(Bucket=self.bucket_name, Key=key, Body=body, ContentType="application/json")
        except ClientError as exc:
            raise SubscriberRankingStoreError(f"Failed to write s3://{self.bucket_name}/{key}: {exc}") from exc
        return key

    def read_result(self, report_date: date) -> dict[str, Any] | None:
        key = subscriber_ranking_key(report_date)
        try:
            body = self.s3_client.get_object(Bucket=self.bucket_name, Key=key)["Body"].read()
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "404"}:
                return None
            raise SubscriberRankingStoreError(f"Failed to read s3://{self.bucket_name}/{key}: {exc}") from exc
        return json.loads(body)
