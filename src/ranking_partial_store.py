"""Temporary S3 JSON objects carrying per-shard bounded ranking results."""

from __future__ import annotations

import json
from datetime import date

from botocore.exceptions import ClientError

from history_ranking import RankedGrowth, ScopeKey
from history_store import HISTORY_SHARD_COUNT

PARTIAL_RANKING_PREFIX = "rankings/partial"


class PartialRankingStoreError(RuntimeError):
    """Raised when a partial ranking cannot be stored or parsed."""


def partial_ranking_key(collection_date: date, shard: int) -> str:
    if isinstance(shard, bool) or not isinstance(shard, int) or not 0 <= shard < HISTORY_SHARD_COUNT:
        raise ValueError(f"shard must be within [0, {HISTORY_SHARD_COUNT}), got {shard!r}")
    return f"{PARTIAL_RANKING_PREFIX}/date={collection_date.isoformat()}/shard={shard:02d}.json"


class S3PartialRankingStore:
    """Idempotent temporary-object storage for reducer inputs."""

    def __init__(self, bucket_name: str, *, s3_client=None) -> None:
        if not bucket_name:
            raise ValueError("bucket_name must not be empty")
        if s3_client is None:
            import boto3

            s3_client = boto3.client("s3")
        self.bucket_name = bucket_name
        self.s3_client = s3_client

    def write(self, collection_date: date, shard: int, rankings) -> str:
        key = partial_ranking_key(collection_date, shard)
        body = json.dumps(_to_payload(rankings), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        try:
            self.s3_client.put_object(
                Bucket=self.bucket_name,
                Key=key,
                Body=body,
                ContentType="application/json",
            )
        except ClientError as exc:
            raise PartialRankingStoreError(f"Failed to write s3://{self.bucket_name}/{key}: {exc}") from exc
        return key

    def read(self, collection_date: date, shard: int):
        key = partial_ranking_key(collection_date, shard)
        try:
            body = self.s3_client.get_object(Bucket=self.bucket_name, Key=key)["Body"].read()
            return _from_payload(json.loads(body))
        except ClientError as exc:
            raise PartialRankingStoreError(f"Failed to read s3://{self.bucket_name}/{key}: {exc}") from exc
        except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
            raise PartialRankingStoreError(f"Invalid partial ranking at {key}: {exc}") from exc


def _to_payload(rankings) -> list[dict]:
    payload = []
    for (scope_type, scope_value), periods in sorted(rankings.items()):
        for period, entries in sorted(periods.items()):
            payload.append(
                {
                    "scopeType": scope_type,
                    "scopeValue": scope_value,
                    "period": period,
                    "entries": [
                        {
                            "rank": entry.rank,
                            "videoId": entry.video_id,
                            "creatorId": entry.creator_id,
                            "viewCount": entry.view_count,
                            "anchorViewCount": entry.anchor_view_count,
                            "gain": entry.gain,
                            "observedAt": entry.observed_at,
                        }
                        for entry in entries
                    ],
                }
            )
    return payload


def _from_payload(payload: list[dict]) -> dict[ScopeKey, dict[str, list[RankedGrowth]]]:
    rankings: dict[ScopeKey, dict[str, list[RankedGrowth]]] = {}
    for group in payload:
        scope = (group["scopeType"], group["scopeValue"])
        period = group["period"]
        rankings.setdefault(scope, {})[period] = [
            RankedGrowth(
                rank=entry["rank"],
                video_id=entry["videoId"],
                creator_id=entry["creatorId"],
                period=period,
                view_count=entry["viewCount"],
                anchor_view_count=entry["anchorViewCount"],
                gain=entry["gain"],
                observed_at=entry["observedAt"],
            )
            for entry in group["entries"]
        ]
    return rankings
