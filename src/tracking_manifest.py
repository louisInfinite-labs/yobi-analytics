"""Compact, sharded tracking catalog consumed by daily collection workers."""

from __future__ import annotations

import io
import os
from dataclasses import dataclass
from typing import Protocol

from botocore.exceptions import ClientError

from history_store import HISTORY_SHARD_COUNT, shard_for_video

MANIFEST_PREFIX = "catalog/current"


class TrackingManifestError(RuntimeError):
    """Raised when a tracking manifest cannot be read, written, or validated."""


@dataclass(frozen=True)
class ManifestEntry:
    """The minimal catalog data a collection worker needs."""

    video_id: str
    creator_id: str
    active: bool = True


class TrackingManifestStore(Protocol):
    """Storage boundary between discovery and daily collection."""

    def write_shard(self, shard: int, entries: list[ManifestEntry]) -> str:
        """Idempotently replace one current-catalog shard."""

    def read_shard(self, shard: int) -> list[ManifestEntry]:
        """Read one current-catalog shard; a missing shard is an error."""


def manifest_key(shard: int) -> str:
    _validate_shard(shard)
    return f"{MANIFEST_PREFIX}/shard={shard:02d}.parquet"


def partition_manifest(entries: list[ManifestEntry]) -> dict[int, list[ManifestEntry]]:
    """Partition the catalog into all deterministic shards."""
    partitions = {shard: [] for shard in range(HISTORY_SHARD_COUNT)}
    for entry in entries:
        _validate_entry(entry)
        partitions[shard_for_video(entry.video_id)].append(entry)
    for shard_entries in partitions.values():
        shard_entries.sort(key=lambda entry: entry.video_id)
    return partitions


def serialize_manifest(entries: list[ManifestEntry]) -> bytes:
    pa, parquet = _pyarrow()
    for entry in entries:
        _validate_entry(entry)
    table = pa.table(
        {
            "videoId": pa.array([entry.video_id for entry in entries], type=pa.string()),
            "creatorId": pa.array([entry.creator_id for entry in entries], type=pa.string()),
            "active": pa.array([entry.active for entry in entries], type=pa.bool_()),
        }
    )
    output = io.BytesIO()
    parquet.write_table(table, output, compression="snappy")
    return output.getvalue()


def deserialize_manifest(payload: bytes) -> list[ManifestEntry]:
    _, parquet = _pyarrow()
    try:
        raw_entries = parquet.read_table(io.BytesIO(payload)).to_pylist()
        return [
            ManifestEntry(
                video_id=entry["videoId"],
                creator_id=entry["creatorId"],
                active=entry["active"],
            )
            for entry in raw_entries
        ]
    except (KeyError, TypeError, ValueError, OSError) as exc:
        raise TrackingManifestError(f"Invalid tracking-manifest Parquet payload: {exc}") from exc


class S3TrackingManifestStore:
    """S3-backed current catalog using the same stable shards as history."""

    def __init__(self, bucket_name: str, *, s3_client=None) -> None:
        if not bucket_name:
            raise ValueError("bucket_name must not be empty")
        if s3_client is None:
            import boto3

            s3_client = boto3.client("s3")
        self.bucket_name = bucket_name
        self.s3_client = s3_client

    @classmethod
    def from_environment(cls, *, s3_client=None) -> "S3TrackingManifestStore":
        bucket_name = os.environ.get("YOBI_HISTORY_BUCKET")
        if not bucket_name:
            raise TrackingManifestError("YOBI_HISTORY_BUCKET is not configured")
        return cls(bucket_name, s3_client=s3_client)

    def write_shard(self, shard: int, entries: list[ManifestEntry]) -> str:
        key = manifest_key(shard)
        wrong_shard = [entry.video_id for entry in entries if shard_for_video(entry.video_id) != shard]
        if wrong_shard:
            raise TrackingManifestError(
                f"Entries do not belong to shard {shard:02d}: {sorted(wrong_shard)}"
            )
        try:
            self.s3_client.put_object(
                Bucket=self.bucket_name,
                Key=key,
                Body=serialize_manifest(sorted(entries, key=lambda entry: entry.video_id)),
                ContentType="application/vnd.apache.parquet",
            )
        except ClientError as exc:
            raise TrackingManifestError(f"Failed to write s3://{self.bucket_name}/{key}: {exc}") from exc
        return key

    def read_shard(self, shard: int) -> list[ManifestEntry]:
        key = manifest_key(shard)
        try:
            body = self.s3_client.get_object(Bucket=self.bucket_name, Key=key)["Body"].read()
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "404"}:
                raise TrackingManifestError(
                    f"Tracking manifest shard does not exist: s3://{self.bucket_name}/{key}"
                ) from exc
            raise TrackingManifestError(f"Failed to read s3://{self.bucket_name}/{key}: {exc}") from exc
        return deserialize_manifest(body)


def publish_tracking_manifest(videos, store: TrackingManifestStore) -> list[str]:
    """Publish the complete tracked catalog after discovery/master changes.

    The caller supplies Video-like objects to avoid coupling the manifest
    abstraction to one metadata backend. All 16 keys are written, including
    empty shards, so removed/deactivated catalog entries cannot linger.
    """
    entries = [
        ManifestEntry(video_id=video.video_id, creator_id=video.creator_id, active=True)
        for video in videos
    ]
    partitions = partition_manifest(entries)
    return [store.write_shard(shard, partitions[shard]) for shard in range(HISTORY_SHARD_COUNT)]


def _validate_shard(shard: int) -> None:
    if isinstance(shard, bool) or not isinstance(shard, int) or not 0 <= shard < HISTORY_SHARD_COUNT:
        raise ValueError(f"shard must be within [0, {HISTORY_SHARD_COUNT}), got {shard!r}")


def _validate_entry(entry: ManifestEntry) -> None:
    if not entry.video_id or not entry.creator_id or not isinstance(entry.active, bool):
        raise TrackingManifestError(f"Manifest entry has invalid required data: {entry!r}")


def _pyarrow():
    try:
        import pyarrow as pa
        import pyarrow.parquet as parquet
    except ImportError as exc:
        raise TrackingManifestError(
            "Parquet support requires pyarrow; install the project requirements"
        ) from exc
    return pa, parquet
