"""Durable S3 archive for YobiTrendingCache payloads (AWS Cost Recovery, third
pass, Scope F).

YobiTrendingCache is now a bounded hot cache (dynamodb_store.put_cached_
trending sets a TTL -- see TRENDING_CACHE_TTL_DAYS there), but read_api.py's
own get_creator_trending/get_organization_trending explicitly support
querying an arbitrary historical reportDate, with no artificial limit on how
far back it can be, and their own docstrings describe this as intentional
("an explicit reportDate never falls back"). So "old ranking output is no
longer needed" is false for this codebase, and a bare TTL would silently
break a real, exercised part of the public API contract the day an item aged
out.

This module is where that data survives past the hot cache's own TTL: every
ranking_reducer.py write is mirrored here too (see its own archive_put wiring),
and read_api.py falls back to this on a YobiTrendingCache miss before
concluding a ranking was never computed at all.
"""

from __future__ import annotations

import json
import os
from typing import Any

from botocore.exceptions import ClientError

ARCHIVE_PREFIX = "trending-cache-archive"


class TrendingCacheArchiveError(RuntimeError):
    """Raised when the S3 trending-cache archive can't be read or written."""


def archive_key(cache_key: str) -> str:
    """One S3 object per DynamoDB cacheKey, mirroring it exactly -- this
    module never re-derives a different key shape, so a payload written here
    is trivially findable from the same key dynamodb_store.put_cached_trending
    was given."""
    return f"{ARCHIVE_PREFIX}/{cache_key}.json"


class S3TrendingCacheArchiveStore:
    """S3-backed durable mirror of YobiTrendingCache, keyed identically."""

    def __init__(self, bucket_name: str, *, s3_client=None) -> None:
        if not bucket_name:
            raise ValueError("bucket_name must not be empty")
        if s3_client is None:
            import boto3

            s3_client = boto3.client("s3")
        self.bucket_name = bucket_name
        self.s3_client = s3_client

    @classmethod
    def from_environment(cls, *, s3_client=None) -> "S3TrendingCacheArchiveStore | None":
        """Return an instance if YOBI_HISTORY_BUCKET is configured, else None --
        mirroring collection.main._publish_manifest_if_configured's own
        "best-effort, only when configured" pattern, so a caller (ranking_
        reducer.py's write side, get_archived_trending's read side) needs no
        conditional-import dance of its own."""
        bucket_name = os.environ.get("YOBI_HISTORY_BUCKET")
        if not bucket_name:
            return None
        return cls(bucket_name, s3_client=s3_client)

    def put(self, cache_key: str, payload: dict[str, Any], *, computed_at: str) -> str:
        """Durably mirror one YobiTrendingCache item. Matches put_cached_
        trending's own call shape exactly so ranking_reducer.py's _paced_put
        can call both through the same interface."""
        key = archive_key(cache_key)
        body = json.dumps({"payload": payload, "computedAt": computed_at}).encode("utf-8")
        try:
            self.s3_client.put_object(Bucket=self.bucket_name, Key=key, Body=body, ContentType="application/json")
        except ClientError as exc:
            raise TrendingCacheArchiveError(f"Failed to write s3://{self.bucket_name}/{key}: {exc}") from exc
        return key

    def get(self, cache_key: str) -> dict[str, Any] | None:
        key = archive_key(cache_key)
        try:
            body = self.s3_client.get_object(Bucket=self.bucket_name, Key=key)["Body"].read()
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "404"}:
                return None
            raise TrendingCacheArchiveError(f"Failed to read s3://{self.bucket_name}/{key}: {exc}") from exc
        return json.loads(body)["payload"]


def get_archived_trending(cache_key: str) -> dict[str, Any] | None:
    """Best-effort archive read for read_api.py's own cache-miss fallback:
    returns None (never raises) when YOBI_HISTORY_BUCKET isn't configured --
    local/dev, or an environment not using the S3 architecture at all -- the
    exact same "no cache available" outcome a genuine miss already produces,
    so a caller needs no extra branching for this case."""
    store = S3TrendingCacheArchiveStore.from_environment()
    if store is None:
        return None
    return store.get(cache_key)
