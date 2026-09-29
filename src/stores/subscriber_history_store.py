"""Deterministic Parquet storage for daily creator subscriber-count history
(ranking-simplification, subscriber-history foundation, R1).

Unlike video history (stores/history_store.py), which shards 16 ways because
the catalog is ~129,000 videos and needs Step-Functions Map parallelism to
stay within a Lambda's timeout, subscriber collection is one observation per
creator per day across the current ~112-creator roster -- trivially small,
with no parallelism need at all. This deliberately does NOT reuse
HISTORY_SHARD_COUNT/shard_for_video: one single S3 object holds the whole
roster for a given day.

Missing-anchor semantics are intentionally stricter than video history's own
new-video-baseline rule (history_ranking._period_value): a video that didn't
exist yet at some anchor date genuinely had zero views, so "not yet
discovered -> 0 baseline" is a real fact, not a guess. A creator's
subscriber count before this project started tracking them is NOT known to
be zero -- so no analogous baseline rule exists here at all. A missing or
hidden subscriber-count observation is never coerced into 0; growth
calculations built on top of this store (a later pass) must treat both cases
as a genuine incomplete result, not a fabricated data point.
"""

from __future__ import annotations

import io
import os
from dataclasses import dataclass
from datetime import date
from typing import Protocol

from botocore.exceptions import ClientError

SUBSCRIBER_HISTORY_PREFIX = "subscriber-history"


class SubscriberHistoryStoreError(RuntimeError):
    """Raised when subscriber history cannot be validated, serialized, or persisted."""


@dataclass(frozen=True)
class SubscriberRow:
    """One creator's subscriber-count observation for one day.

    `subscriber_count` is None exactly when `hidden_subscriber_count` is
    True -- YouTube's own channels().list(part="statistics") response
    returns a fabricated "0" for a channel whose owner has hidden their
    subscriber count, which must never be persisted or treated as a real
    value (see collection.youtube_client.get_channel_statistics's own
    docstring). A creator whose collection failed outright for the day (a
    YouTube API/network failure, a deleted/invalid channel) simply has no
    row at all -- there is no "unavailable" sentinel row, mirroring
    HistoryRow's own convention of only ever writing rows for successfully
    fetched items and tracking failures separately as skip reasons.
    """

    creator_id: str
    subscriber_count: int | None
    hidden_subscriber_count: bool
    observed_at: str


class SubscriberHistoryStore(Protocol):
    """Storage boundary for daily creator subscriber-count snapshots."""

    def write_daily_snapshot(self, collection_date: date, rows: list[SubscriberRow]) -> str:
        """Idempotently replace one day's whole-roster subscriber snapshot."""

    def read_daily_snapshot(self, collection_date: date) -> list[SubscriberRow]:
        """Read one day's snapshot, returning an empty list when it is absent."""

    def snapshot_exists(self, collection_date: date) -> bool:
        """Return whether this day's snapshot has already been written."""


def subscriber_history_key(collection_date: date) -> str:
    """Return the canonical S3 key for one day's whole-roster subscriber snapshot.

    No shard segment (unlike daily_history_key) -- one object per day for the
    entire roster, see this module's own docstring for why sharding would be
    unwarranted here.
    """
    return f"{SUBSCRIBER_HISTORY_PREFIX}/date={collection_date.isoformat()}.parquet"


def serialize_subscriber_rows(rows: list[SubscriberRow]) -> bytes:
    """Serialize compact rows as Snappy-compressed Parquet bytes."""
    pa, parquet = _pyarrow()
    for row in rows:
        _validate_row(row)
    table = pa.table(
        {
            "creatorId": pa.array([row.creator_id for row in rows], type=pa.string()),
            "subscriberCount": pa.array([row.subscriber_count for row in rows], type=pa.int64()),
            "hiddenSubscriberCount": pa.array([row.hidden_subscriber_count for row in rows], type=pa.bool_()),
            "observedAt": pa.array([row.observed_at for row in rows], type=pa.string()),
        }
    )
    output = io.BytesIO()
    parquet.write_table(table, output, compression="snappy")
    return output.getvalue()


def deserialize_subscriber_rows(payload: bytes) -> list[SubscriberRow]:
    """Deserialize Parquet bytes and validate the minimal subscriber-history schema."""
    _, parquet = _pyarrow()
    try:
        raw_rows = parquet.read_table(io.BytesIO(payload)).to_pylist()
        rows = [
            SubscriberRow(
                creator_id=row["creatorId"],
                subscriber_count=row["subscriberCount"],
                hidden_subscriber_count=row["hiddenSubscriberCount"],
                observed_at=row["observedAt"],
            )
            for row in raw_rows
        ]
    except (KeyError, TypeError, ValueError, OSError) as exc:
        raise SubscriberHistoryStoreError(f"Invalid subscriber-history Parquet payload: {exc}") from exc
    for row in rows:
        _validate_row(row)
    _reject_duplicate_creator_ids(rows)
    return rows


class S3SubscriberHistoryStore:
    """S3 implementation: one whole-roster object per day, no sharding."""

    def __init__(self, bucket_name: str, *, s3_client=None) -> None:
        if not bucket_name:
            raise ValueError("bucket_name must not be empty")
        if s3_client is None:
            import boto3

            s3_client = boto3.client("s3")
        self.bucket_name = bucket_name
        self.s3_client = s3_client

    @classmethod
    def from_environment(cls, *, s3_client=None) -> "S3SubscriberHistoryStore":
        bucket_name = os.environ.get("YOBI_HISTORY_BUCKET")
        if not bucket_name:
            raise SubscriberHistoryStoreError("YOBI_HISTORY_BUCKET is not configured")
        return cls(bucket_name, s3_client=s3_client)

    def write_daily_snapshot(self, collection_date: date, rows: list[SubscriberRow]) -> str:
        key = subscriber_history_key(collection_date)
        _reject_duplicate_creator_ids(rows)
        body = serialize_subscriber_rows(sorted(rows, key=lambda row: row.creator_id))
        try:
            self.s3_client.put_object(
                Bucket=self.bucket_name,
                Key=key,
                Body=body,
                ContentType="application/vnd.apache.parquet",
            )
        except ClientError as exc:
            raise SubscriberHistoryStoreError(f"Failed to write s3://{self.bucket_name}/{key}: {exc}") from exc
        return key

    def read_daily_snapshot(self, collection_date: date) -> list[SubscriberRow]:
        key = subscriber_history_key(collection_date)
        try:
            body = self.s3_client.get_object(Bucket=self.bucket_name, Key=key)["Body"].read()
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "404"}:
                return []
            raise SubscriberHistoryStoreError(f"Failed to read s3://{self.bucket_name}/{key}: {exc}") from exc
        return deserialize_subscriber_rows(body)

    def snapshot_exists(self, collection_date: date) -> bool:
        key = subscriber_history_key(collection_date)
        try:
            self.s3_client.head_object(Bucket=self.bucket_name, Key=key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "404", "NotFound"}:
                return False
            raise SubscriberHistoryStoreError(f"Failed to check s3://{self.bucket_name}/{key}: {exc}") from exc
        return True


def _validate_row(row: SubscriberRow) -> None:
    if not row.creator_id or not row.observed_at:
        raise SubscriberHistoryStoreError(f"Subscriber row has an empty required field: {row!r}")
    if not isinstance(row.hidden_subscriber_count, bool):
        raise SubscriberHistoryStoreError(f"Subscriber row has invalid hidden_subscriber_count: {row!r}")
    if row.hidden_subscriber_count:
        if row.subscriber_count is not None:
            raise SubscriberHistoryStoreError(
                f"Subscriber row marked hidden must not carry a subscriber_count: {row!r}"
            )
    else:
        if row.subscriber_count is None:
            raise SubscriberHistoryStoreError(
                f"Subscriber row not marked hidden must carry a real subscriber_count: {row!r}"
            )
        if (
            isinstance(row.subscriber_count, bool)
            or not isinstance(row.subscriber_count, int)
            or row.subscriber_count < 0
        ):
            raise SubscriberHistoryStoreError(f"Subscriber row has invalid subscriber_count: {row!r}")


def _reject_duplicate_creator_ids(rows: list[SubscriberRow]) -> None:
    """Fail fast on the same creator_id appearing twice in one day's snapshot --
    there is exactly one roster-wide object per day, so a duplicate means the
    snapshot itself is corrupt, not a legitimate multi-observation state."""
    seen: set[str] = set()
    duplicates: set[str] = set()
    for row in rows:
        if row.creator_id in seen:
            duplicates.add(row.creator_id)
        seen.add(row.creator_id)
    if duplicates:
        raise SubscriberHistoryStoreError(
            f"Subscriber snapshot contains duplicate creator_id entries: {sorted(duplicates)}"
        )


def _pyarrow():
    try:
        import pyarrow as pa
        import pyarrow.parquet as parquet
    except ImportError as exc:
        raise SubscriberHistoryStoreError(
            "Parquet support requires pyarrow; install the project requirements"
        ) from exc
    return pa, parquet
