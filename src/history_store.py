"""Deterministic Parquet storage for permanent daily view history.

Daily history is partitioned by collection date and a stable video-id shard.
The interface keeps S3/boto3 details out of collection and ranking code, and
the per-shard write operation is the unit of retry: a failed shard can be
rewritten without deleting any shard that already succeeded.
"""

from __future__ import annotations

import hashlib
import io
import os
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Protocol

from botocore.exceptions import ClientError

HISTORY_SHARD_COUNT = 16
HISTORY_PREFIX = "history/daily"
MONTHLY_HISTORY_PREFIX = "history/monthly"
EXACT_ANCHOR_DAYS = (1, 7, 30)


class HistoryStoreError(RuntimeError):
    """Raised when history cannot be validated, serialized, or persisted."""


@dataclass(frozen=True)
class HistoryRow:
    """One compact public-view observation.

    The collection date belongs to the S3 partition, so it is intentionally
    absent from each row. Presentation metadata remains in master/cache data.
    """

    video_id: str
    creator_id: str
    view_count: int
    observed_at: str
    availability_status: str


class HistoryStore(Protocol):
    """Storage boundary used by collection and exact-anchor ranking."""

    def write_daily_shard(self, collection_date: date, shard: int, rows: list[HistoryRow]) -> str:
        """Idempotently replace one deterministic daily shard."""

    def read_daily_shard(self, collection_date: date, shard: int) -> list[HistoryRow]:
        """Read one daily shard, returning an empty list when it is absent."""


def shard_for_video(video_id: str, shard_count: int = HISTORY_SHARD_COUNT) -> int:
    """Map a video id to a stable shard without Python's randomized hash()."""
    if not video_id:
        raise ValueError("video_id must not be empty")
    _validate_shard_count(shard_count)
    digest = hashlib.sha256(video_id.encode("utf-8")).digest()
    return int.from_bytes(digest, byteorder="big") % shard_count


def daily_history_key(collection_date: date, shard: int) -> str:
    """Return the canonical S3 key for a daily history shard."""
    _validate_shard(shard)
    return f"{HISTORY_PREFIX}/date={collection_date.isoformat()}/shard={shard:02d}.parquet"


def monthly_history_key(year: int, month: int, shard: int) -> str:
    """Return the future monthly-compaction key for the same row schema."""
    if year < 1 or not 1 <= month <= 12:
        raise ValueError(f"invalid year/month: {year:04d}-{month:02d}")
    _validate_shard(shard)
    return f"{MONTHLY_HISTORY_PREFIX}/year={year:04d}/month={month:02d}/shard={shard:02d}.parquet"


def exact_anchor_dates(report_date: date) -> tuple[date, date, date]:
    """Return the only historical dates ranking is allowed to read."""
    return tuple(report_date - timedelta(days=days) for days in EXACT_ANCHOR_DAYS)


def partition_history_rows(rows: list[HistoryRow]) -> dict[int, list[HistoryRow]]:
    """Partition rows into all 16 shards, including deterministic empty ones."""
    partitions = {shard: [] for shard in range(HISTORY_SHARD_COUNT)}
    for row in rows:
        _validate_row(row)
        partitions[shard_for_video(row.video_id)].append(row)
    for shard_rows in partitions.values():
        shard_rows.sort(key=lambda row: row.video_id)
    return partitions


def serialize_history_rows(rows: list[HistoryRow]) -> bytes:
    """Serialize compact rows as Snappy-compressed Parquet bytes."""
    pa, parquet = _pyarrow()
    for row in rows:
        _validate_row(row)
    table = pa.table(
        {
            "videoId": pa.array([row.video_id for row in rows], type=pa.string()),
            "creatorId": pa.array([row.creator_id for row in rows], type=pa.string()),
            "viewCount": pa.array([row.view_count for row in rows], type=pa.int64()),
            "observedAt": pa.array([row.observed_at for row in rows], type=pa.string()),
            "availabilityStatus": pa.array(
                [row.availability_status for row in rows], type=pa.string()
            ),
        }
    )
    output = io.BytesIO()
    parquet.write_table(table, output, compression="snappy")
    return output.getvalue()


def deserialize_history_rows(payload: bytes) -> list[HistoryRow]:
    """Deserialize Parquet bytes and validate their minimal history schema."""
    _, parquet = _pyarrow()
    try:
        raw_rows = parquet.read_table(io.BytesIO(payload)).to_pylist()
        return [
            HistoryRow(
                video_id=row["videoId"],
                creator_id=row["creatorId"],
                view_count=row["viewCount"],
                observed_at=row["observedAt"],
                availability_status=row["availabilityStatus"],
            )
            for row in raw_rows
        ]
    except (KeyError, TypeError, ValueError, OSError) as exc:
        raise HistoryStoreError(f"Invalid history Parquet payload: {exc}") from exc


class S3HistoryStore:
    """S3 implementation whose idempotency boundary is one shard object."""

    def __init__(self, bucket_name: str, *, s3_client=None) -> None:
        if not bucket_name:
            raise ValueError("bucket_name must not be empty")
        if s3_client is None:
            import boto3

            s3_client = boto3.client("s3")
        self.bucket_name = bucket_name
        self.s3_client = s3_client

    @classmethod
    def from_environment(cls, *, s3_client=None) -> "S3HistoryStore":
        bucket_name = os.environ.get("YOBI_HISTORY_BUCKET")
        if not bucket_name:
            raise HistoryStoreError("YOBI_HISTORY_BUCKET is not configured")
        return cls(bucket_name, s3_client=s3_client)

    def write_daily_shard(self, collection_date: date, shard: int, rows: list[HistoryRow]) -> str:
        key = daily_history_key(collection_date, shard)
        wrong_shard = [row.video_id for row in rows if shard_for_video(row.video_id) != shard]
        if wrong_shard:
            raise HistoryStoreError(
                f"Rows do not belong to shard {shard:02d}: {sorted(wrong_shard)}"
            )
        body = serialize_history_rows(sorted(rows, key=lambda row: row.video_id))
        try:
            self.s3_client.put_object(
                Bucket=self.bucket_name,
                Key=key,
                Body=body,
                ContentType="application/vnd.apache.parquet",
            )
        except ClientError as exc:
            raise HistoryStoreError(f"Failed to write s3://{self.bucket_name}/{key}: {exc}") from exc
        return key

    def read_daily_shard(self, collection_date: date, shard: int) -> list[HistoryRow]:
        key = daily_history_key(collection_date, shard)
        try:
            body = self.s3_client.get_object(Bucket=self.bucket_name, Key=key)["Body"].read()
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "404"}:
                return []
            raise HistoryStoreError(f"Failed to read s3://{self.bucket_name}/{key}: {exc}") from exc
        return deserialize_history_rows(body)


def _validate_shard(shard: int) -> None:
    if isinstance(shard, bool) or not isinstance(shard, int) or not 0 <= shard < HISTORY_SHARD_COUNT:
        raise ValueError(f"shard must be within [0, {HISTORY_SHARD_COUNT}), got {shard!r}")


def _validate_shard_count(shard_count: int) -> None:
    if isinstance(shard_count, bool) or not isinstance(shard_count, int) or shard_count < 1:
        raise ValueError(f"shard_count must be a positive integer, got {shard_count!r}")


def _validate_row(row: HistoryRow) -> None:
    if not row.video_id or not row.creator_id or not row.observed_at or not row.availability_status:
        raise HistoryStoreError(f"History row has an empty required field: {row!r}")
    if isinstance(row.view_count, bool) or not isinstance(row.view_count, int) or row.view_count < 0:
        raise HistoryStoreError(f"History row has invalid view_count: {row!r}")


def _pyarrow():
    try:
        import pyarrow as pa
        import pyarrow.parquet as parquet
    except ImportError as exc:
        raise HistoryStoreError(
            "Parquet support requires pyarrow; install the project requirements"
        ) from exc
    return pa, parquet
