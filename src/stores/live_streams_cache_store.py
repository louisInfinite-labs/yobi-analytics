"""Shared cache store for the `/live-streams` upstream protection (SEC-API-005, roadmap MT-22; ADR-001).

One JSON object in the existing history bucket (`live-streams/current.json`) is the cache every API container reads and
writes, so the freshness window and the 429 cooldown hold across containers. A small in-container (L1) copy in front of it
bounds S3 reads. The entry format and all policy live in api.live_streams_protection; this module only moves bytes.
"""

from __future__ import annotations

import time
from typing import Any, Callable

from botocore.exceptions import BotoCoreError, ClientError

from api.live_streams_protection import CacheEntry
from stores.history_bucket import resolve_history_bucket

LIVE_STREAMS_CACHE_KEY = "live-streams/current.json"

# How long a container trusts its own copy before re-reading the shared object. Short, so a cooldown or refresh written by
# another container is seen quickly; it only bounds S3 GETs, the protection policy still judges the entry's real age.
DEFAULT_L1_TTL_SECONDS = 5.0


class LiveStreamsCacheStoreError(RuntimeError):
    """The shared cache object could not be read or written."""


class S3LiveStreamsCacheStore:
    """The shared cache (S3 object + L1). Implements api.live_streams_protection.CacheStore."""

    def __init__(
        self,
        bucket_name: str | None = None,
        *,
        s3_client: Any = None,
        clock: Callable[[], float] = time.time,
        l1_ttl_seconds: float = DEFAULT_L1_TTL_SECONDS,
    ) -> None:
        self.bucket_name = bucket_name or resolve_history_bucket()
        if s3_client is None:
            import boto3

            s3_client = boto3.client("s3")
        self.s3_client = s3_client
        self._clock = clock
        self._l1_ttl = l1_ttl_seconds
        self._l1_entry: CacheEntry | None = None
        self._l1_loaded_at: float | None = None
        self.last_read_source = "none"

    def read(self) -> CacheEntry | None:
        now = self._clock()
        if self._l1_loaded_at is not None and now - self._l1_loaded_at < self._l1_ttl:
            self.last_read_source = "l1"
            return self._l1_entry
        try:
            body = self.s3_client.get_object(Bucket=self.bucket_name, Key=LIVE_STREAMS_CACHE_KEY)["Body"].read()
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "404"}:
                self._remember(None, now)
                self.last_read_source = "shared"
                return None
            raise LiveStreamsCacheStoreError(f"Failed to read the live-streams cache: {exc}") from exc
        except BotoCoreError as exc:
            raise LiveStreamsCacheStoreError(f"Failed to read the live-streams cache: {exc}") from exc
        entry = CacheEntry.from_json(body)  # malformed stored data is treated as "no entry", never trusted
        self._remember(entry, now)
        self.last_read_source = "shared"
        return entry

    def write(self, entry: CacheEntry) -> None:
        self._remember(entry, self._clock())  # this container always sees its own latest write
        try:
            self.s3_client.put_object(
                Bucket=self.bucket_name,
                Key=LIVE_STREAMS_CACHE_KEY,
                Body=entry.to_json().encode("utf-8"),
                ContentType="application/json",
            )
        except (ClientError, BotoCoreError) as exc:
            raise LiveStreamsCacheStoreError(f"Failed to write the live-streams cache: {exc}") from exc

    def _remember(self, entry: CacheEntry | None, now: float) -> None:
        self._l1_entry = entry
        self._l1_loaded_at = now
