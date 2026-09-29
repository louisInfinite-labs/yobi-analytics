"""Temporary S3 JSON objects carrying per-shard bounded ranking results."""

from __future__ import annotations

import json
from datetime import date

from botocore.exceptions import ClientError

from analytics.history_ranking import RankedGrowth, ScopeKey
from stores.history_store import HISTORY_SHARD_COUNT

PARTIAL_RANKING_PREFIX = "rankings/partial"

# v1 was a bare JSON array (scope rankings only, no wrapper object at all).
# v2 added an explicit schemaVersion and wrapped the scope-ranking array in
# an object, alongside a creatorPartials field that carried each shard's
# per-creator/per-period partial. R7 (AWS Cost Recovery) had already removed
# an earlier, similarly additive topicPartials v2 field once its consumer
# reached zero. R8B (AWS Cost Recovery): creatorPartials itself is now
# removed the same way -- creator_period_partials/CreatorPeriodPartial
# (analytics.history_ranking) had no remaining production consumer once
# persist_creator_summaries/creatorSummary:* (comparison_api.py, its last
# reader) was retired -- both the writer (history_worker.py/
# history_worker_handler.py) and the only reader (ranking_reducer.py) were
# changed in the same pass. Unlike topicPartials, creatorPartials was never
# read tolerantly (see the old `payload["creatorPartials"]` -- a required
# key, not `.get()`) -- a reducer invocation still running the pre-R8B code
# while history_worker's Lambda has already rolled forward would fail
# reading a new, creatorPartials-less bundle. This diff cannot retroactively
# make already-deployed old code tolerant; only a deploy order that updates
# ranking_reducer before (or atomically with) history_worker closes that
# window -- new code reading an *old* bundle that still carries a stray
# creatorPartials key is unaffected either way, since it is simply never
# looked at below. No schemaVersion bump: the object's remaining shape
# (schemaVersion + scopeRankings) is unchanged.
PARTIAL_RANKING_SCHEMA_VERSION = 2


class PartialRankingStoreError(RuntimeError):
    """Raised when a partial ranking cannot be stored or parsed."""


def partial_ranking_key(collection_date: date, shard: int) -> str:
    if isinstance(shard, bool) or not isinstance(shard, int) or not 0 <= shard < HISTORY_SHARD_COUNT:
        raise ValueError(f"shard must be within [0, {HISTORY_SHARD_COUNT}), got {shard!r}")
    return f"{PARTIAL_RANKING_PREFIX}/date={collection_date.isoformat()}/shard={shard:02d}.json"


class S3PartialRankingStore:
    """Idempotent temporary-object storage for reducer inputs.

    One object per (collection_date, shard) carries this shard's bounded
    scope (creator/organization) Top-N video rankings -- one write() call,
    one PutObject, regardless of how much this payload carries.
    """

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
        payload = {
            "schemaVersion": PARTIAL_RANKING_SCHEMA_VERSION,
            "scopeRankings": _scope_rankings_to_payload(rankings),
        }
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
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

    def read(self, collection_date: date, shard: int) -> dict[ScopeKey, dict[str, list[RankedGrowth]]]:
        """Return this shard's scope (video) rankings -- its own S3 GetObject."""
        return _from_payload(self._read_payload(collection_date, shard))["scopeRankings"]

    def _read_payload(self, collection_date: date, shard: int) -> dict:
        key = partial_ranking_key(collection_date, shard)
        try:
            body = self.s3_client.get_object(Bucket=self.bucket_name, Key=key)["Body"].read()
            return json.loads(body)
        except ClientError as exc:
            raise PartialRankingStoreError(f"Failed to read s3://{self.bucket_name}/{key}: {exc}") from exc
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PartialRankingStoreError(f"Invalid partial ranking at {key}: {exc}") from exc


def _scope_rankings_to_payload(rankings) -> list[dict]:
    payload = []
    for (scope_type, scope_value), periods in sorted(rankings.items()):
        for period, entries in sorted(periods.items()):
            payload.append(
                {
                    "scopeType": scope_type,
                    "scopeValue": scope_value,
                    "period": period,
                    "entries": [_ranked_growth_to_payload(entry) for entry in entries],
                }
            )
    return payload


def _ranked_growth_to_payload(entry: RankedGrowth) -> dict:
    return {
        "rank": entry.rank,
        "videoId": entry.video_id,
        "creatorId": entry.creator_id,
        "viewCount": entry.view_count,
        "anchorViewCount": entry.anchor_view_count,
        "gain": entry.gain,
        "observedAt": entry.observed_at,
    }


def _ranked_growth_from_payload(entry: dict, *, period: str) -> RankedGrowth:
    return RankedGrowth(
        rank=entry["rank"],
        video_id=entry["videoId"],
        creator_id=entry["creatorId"],
        period=period,
        view_count=entry["viewCount"],
        anchor_view_count=entry["anchorViewCount"],
        gain=entry["gain"],
        observed_at=entry["observedAt"],
    )


def _from_payload(payload: dict) -> dict:
    """Parse a whole v2 payload object into {"scopeRankings": ...}.

    Requires schemaVersion == PARTIAL_RANKING_SCHEMA_VERSION exactly — fails
    fast (rather than guessing at an older/newer shape) on anything else,
    the same "an obviously wrong shape must never be silently reinterpreted"
    principle tracking_manifest.py's own read-time validation already
    applies. A payload written by a pre-R8B producer may still carry a
    "creatorPartials" key -- deliberately never looked at here, so an old
    bundle read by this new code is unaffected either way (see this
    module's own R8B note above for the one direction that isn't safe).
    """
    try:
        if not isinstance(payload, dict) or payload.get("schemaVersion") != PARTIAL_RANKING_SCHEMA_VERSION:
            raise PartialRankingStoreError(
                f"Unsupported partial ranking schemaVersion: {payload.get('schemaVersion') if isinstance(payload, dict) else type(payload)!r}"
            )
        scope_rankings: dict[ScopeKey, dict[str, list[RankedGrowth]]] = {}
        for group in payload["scopeRankings"]:
            scope = (group["scopeType"], group["scopeValue"])
            period = group["period"]
            scope_rankings.setdefault(scope, {})[period] = [
                _ranked_growth_from_payload(entry, period=period) for entry in group["entries"]
            ]
    except (KeyError, TypeError, ValueError) as exc:
        raise PartialRankingStoreError(f"Invalid partial ranking payload: {exc}") from exc
    return {"scopeRankings": scope_rankings}
