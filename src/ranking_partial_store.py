"""Temporary S3 JSON objects carrying per-shard bounded ranking results."""

from __future__ import annotations

import json
from datetime import date

from botocore.exceptions import ClientError

from history_ranking import CreatorPeriodPartial, RankedGrowth, ScopeKey
from history_store import HISTORY_SHARD_COUNT

PARTIAL_RANKING_PREFIX = "rankings/partial"

# v1 was a bare JSON array (scope rankings only, no wrapper object at all).
# v2 adds an explicit schemaVersion and wraps both the original scope-ranking
# array and the new per-creator/per-period partial alongside it in the same
# object -- same S3 key, same one PUT per shard, no new bucket/prefix. Only
# ever written by write() below; read() requires it (see read()'s own
# docstring for why v1 is not accepted rather than silently upgraded).
PARTIAL_RANKING_SCHEMA_VERSION = 2


class PartialRankingStoreError(RuntimeError):
    """Raised when a partial ranking cannot be stored or parsed."""


def partial_ranking_key(collection_date: date, shard: int) -> str:
    if isinstance(shard, bool) or not isinstance(shard, int) or not 0 <= shard < HISTORY_SHARD_COUNT:
        raise ValueError(f"shard must be within [0, {HISTORY_SHARD_COUNT}), got {shard!r}")
    return f"{PARTIAL_RANKING_PREFIX}/date={collection_date.isoformat()}/shard={shard:02d}.json"


class S3PartialRankingStore:
    """Idempotent temporary-object storage for reducer inputs.

    One object per (collection_date, shard) carries both this shard's
    bounded scope (creator/organization/branch/global) Top-N video rankings
    and its bounded per-creator/per-period partials (view sum, catalog/
    eligible video counts, Top-N candidates) -- one write() call, one
    PutObject, regardless of how much this payload carries.
    """

    def __init__(self, bucket_name: str, *, s3_client=None) -> None:
        if not bucket_name:
            raise ValueError("bucket_name must not be empty")
        if s3_client is None:
            import boto3

            s3_client = boto3.client("s3")
        self.bucket_name = bucket_name
        self.s3_client = s3_client

    def write(
        self,
        collection_date: date,
        shard: int,
        rankings,
        creator_partials: dict[str, dict[str, CreatorPeriodPartial]],
    ) -> str:
        key = partial_ranking_key(collection_date, shard)
        payload = {
            "schemaVersion": PARTIAL_RANKING_SCHEMA_VERSION,
            "scopeRankings": _scope_rankings_to_payload(rankings),
            "creatorPartials": _creator_partials_to_payload(creator_partials),
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
        """Return this shard's scope (video) rankings only.

        Costs its own S3 GetObject — a caller that also needs creator
        partials for the same shard should use read_bundle instead of
        calling this and read_creator_partials separately, which would
        fetch and parse the same object twice. Kept only for a caller that
        genuinely wants scope rankings alone.
        """
        return _from_payload(self._read_payload(collection_date, shard))["scopeRankings"]

    def read_creator_partials(
        self, collection_date: date, shard: int
    ) -> dict[str, dict[str, CreatorPeriodPartial]]:
        """Return this shard's per-creator/per-period partials.

        Same caveat as read(): its own S3 GetObject. Use read_bundle when a
        caller needs both halves of one shard's payload.
        """
        return _from_payload(self._read_payload(collection_date, shard))["creatorPartials"]

    def read_bundle(
        self, collection_date: date, shard: int
    ) -> tuple[dict[ScopeKey, dict[str, list[RankedGrowth]]], dict[str, dict[str, CreatorPeriodPartial]]]:
        """Return (scope_rankings, creator_partials) for one shard from a single
        S3 GetObject and a single JSON parse.

        This is what a caller needing both halves of one shard's payload
        (e.g. ranking_reducer.py's incremental merge loop) should use —
        calling read() and read_creator_partials() separately for the same
        shard would cost two GetObject calls and two full JSON parses of
        the same (potentially several-MB) object instead of one of each.
        """
        parsed = _from_payload(self._read_payload(collection_date, shard))
        return parsed["scopeRankings"], parsed["creatorPartials"]

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


def _creator_partials_to_payload(creator_partials: dict[str, dict[str, CreatorPeriodPartial]]) -> list[dict]:
    payload = []
    for creator_id, periods in sorted(creator_partials.items()):
        for period, agg in sorted(periods.items()):
            payload.append(
                {
                    "creatorId": creator_id,
                    "period": period,
                    "viewSum": agg.view_sum,
                    "catalogVideoCount": agg.catalog_video_count,
                    "eligibleVideoCount": agg.eligible_video_count,
                    "isComplete": agg.is_complete,
                    "topCandidates": [_ranked_growth_to_payload(entry) for entry in agg.top_candidates],
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
    """Parse a whole v2 payload object into {"scopeRankings": ..., "creatorPartials": ...}.

    Requires schemaVersion == PARTIAL_RANKING_SCHEMA_VERSION exactly — fails
    fast (rather than guessing at an older/newer shape) on anything else,
    the same "an obviously wrong shape must never be silently reinterpreted"
    principle tracking_manifest.py's own read-time validation already
    applies. There is no v1 data left to read: this is a same-day-only
    temporary store the reducer consumes and the next day's run overwrites,
    so a version mismatch here means a real deploy/rollback problem worth
    surfacing loudly, not a compatibility case to paper over.
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

        creator_partials: dict[str, dict[str, CreatorPeriodPartial]] = {}
        for group in payload["creatorPartials"]:
            creator_id = group["creatorId"]
            period = group["period"]
            creator_partials.setdefault(creator_id, {})[period] = CreatorPeriodPartial(
                creator_id=creator_id,
                period=period,
                view_sum=group["viewSum"],
                catalog_video_count=group["catalogVideoCount"],
                eligible_video_count=group["eligibleVideoCount"],
                top_candidates=[
                    _ranked_growth_from_payload(entry, period=period) for entry in group["topCandidates"]
                ],
            )
    except (KeyError, TypeError, ValueError) as exc:
        raise PartialRankingStoreError(f"Invalid partial ranking payload: {exc}") from exc
    return {"scopeRankings": scope_rankings, "creatorPartials": creator_partials}
