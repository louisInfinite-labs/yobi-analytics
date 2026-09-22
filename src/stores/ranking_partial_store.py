"""Temporary S3 JSON objects carrying per-shard bounded ranking results."""

from __future__ import annotations

import json
from datetime import date

from botocore.exceptions import ClientError

from analytics.history_ranking import CreatorPeriodPartial, RankedGrowth, ScopeKey, TopicPeriodPartial
from stores.history_store import HISTORY_SHARD_COUNT

PARTIAL_RANKING_PREFIX = "rankings/partial"

# v1 was a bare JSON array (scope rankings only, no wrapper object at all).
# v2 added an explicit schemaVersion and wrapped both the original scope-
# ranking array and the per-creator/per-period partial alongside it in the
# same object. Still v2: Topic Phase 3's new "topicPartials" array is added
# as an OPTIONAL, purely additive third field within this same schema
# version, deliberately NOT a v3 bump -- see _from_payload's own docstring
# for why a version bump here would be unsafe. Only ever written by write()
# below; read() still requires schemaVersion == 2 exactly (an unrelated,
# genuinely incompatible shape change would still need a real bump and a
# fail-fast rejection, same as the v1->v2 migration).
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
        topic_partials: dict[str, dict[str, TopicPeriodPartial]] | None = None,
    ) -> str:
        key = partial_ranking_key(collection_date, shard)
        payload = {
            "schemaVersion": PARTIAL_RANKING_SCHEMA_VERSION,
            "scopeRankings": _scope_rankings_to_payload(rankings),
            "creatorPartials": _creator_partials_to_payload(creator_partials),
            "topicPartials": _topic_partials_to_payload(topic_partials or {}),
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

    def read_topic_partials(self, collection_date: date, shard: int) -> dict[str, dict[str, TopicPeriodPartial]]:
        """Return this shard's per-creator/per-topic partials (Topic Phase 3).

        Same caveat as read()/read_creator_partials(): its own S3 GetObject.
        Use read_bundle when a caller needs every part of one shard's payload.
        """
        return _from_payload(self._read_payload(collection_date, shard))["topicPartials"]

    def read_bundle(self, collection_date: date, shard: int) -> tuple[
        dict[ScopeKey, dict[str, list[RankedGrowth]]],
        dict[str, dict[str, CreatorPeriodPartial]],
        dict[str, dict[str, TopicPeriodPartial]],
    ]:
        """Return (scope_rankings, creator_partials, topic_partials) for one
        shard from a single S3 GetObject and a single JSON parse.

        This is what a caller needing every part of one shard's payload
        (e.g. ranking_reducer.py's incremental merge loop) should use —
        calling read()/read_creator_partials()/read_topic_partials()
        separately for the same shard would cost three GetObject calls and
        three full JSON parses of the same (potentially several-MB) object
        instead of one of each.
        """
        parsed = _from_payload(self._read_payload(collection_date, shard))
        return parsed["scopeRankings"], parsed["creatorPartials"], parsed["topicPartials"]

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


def _topic_partials_to_payload(topic_partials: dict[str, dict[str, TopicPeriodPartial]]) -> list[dict]:
    payload = []
    for creator_id, topics in sorted(topic_partials.items()):
        for topic, agg in sorted(topics.items()):
            payload.append(
                {
                    "creatorId": creator_id,
                    "topic": topic,
                    "viewSum": agg.view_sum,
                    "videoCount": agg.video_count,
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
    """Parse a whole v2 payload object into {"scopeRankings": ..., "creatorPartials": ..., "topicPartials": ...}.

    Requires schemaVersion == PARTIAL_RANKING_SCHEMA_VERSION exactly — fails
    fast (rather than guessing at an older/newer shape) on anything else,
    the same "an obviously wrong shape must never be silently reinterpreted"
    principle tracking_manifest.py's own read-time validation already
    applies.

    `topicPartials` is read via `payload.get("topicPartials", [])`,
    deliberately tolerant of the key being entirely absent — unlike
    `scopeRankings`/`creatorPartials`, which have been mandatory since v2.
    This is what keeps a mixed-version rollout of the Step Functions Map
    safe (Topic Phase 3): a day's 16 shard invocations are not guaranteed to
    all run the same Lambda code version if a deploy lands mid-execution.
      A. an old-code shard (writes no topicPartials key at all) read by a
         new reducer: that shard simply contributes no topic data for the
         day — every existing scope/creator ranking is unaffected, and
         topic_partials() safely reports less than the true full-day total
         rather than raising.
      B. a new-code shard (writes topicPartials) read by an old reducer:
         the old reducer only ever reads scopeRankings/creatorPartials by
         key name — an unread extra key in the same dict is simply ignored,
         standard JSON-object forward compatibility.
      C. both new: full topic data flows end to end, as designed.
    None of these three ever raises PartialRankingStoreError, because
    topicPartials was never added to the version-defining contract at all.
    A genuinely incompatible future change to scopeRankings/creatorPartials
    themselves would still need a real version bump and this same
    fail-fast rejection — this is not a general anti-pattern, just this one
    field's own, deliberately backward-compatible design.
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

        topic_partials: dict[str, dict[str, TopicPeriodPartial]] = {}
        for group in payload.get("topicPartials", []):
            creator_id = group["creatorId"]
            topic = group["topic"]
            topic_partials.setdefault(creator_id, {})[topic] = TopicPeriodPartial(
                creator_id=creator_id,
                topic=topic,
                view_sum=group["viewSum"],
                video_count=group["videoCount"],
            )
    except (KeyError, TypeError, ValueError) as exc:
        raise PartialRankingStoreError(f"Invalid partial ranking payload: {exc}") from exc
    return {"scopeRankings": scope_rankings, "creatorPartials": creator_partials, "topicPartials": topic_partials}
