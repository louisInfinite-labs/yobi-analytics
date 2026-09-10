"""Lambda entry point for one deterministic daily history shard."""

from __future__ import annotations

import os
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

import execution_lock
from config import get_api_key
from creator_master import load_creators
from history_ranking import CreatorDimensions
from history_store import HISTORY_SHARD_COUNT, S3HistoryStore
from history_worker import collect_history_shard
from ranking_partial_store import S3PartialRankingStore
from tracking_manifest import S3TrackingManifestStore
from youtube_client import build_youtube_client

COLLECTION_TIMEZONE = ZoneInfo("Asia/Tokyo")


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Collect one shard and persist its history plus bounded reducer input.

    Also doubles as terraform/history.tf's `ValidateShardsInput` state
    (`shards`, plural) and `AcquireExecutionLock` state (`validatedShards`)
    ahead of the Step Functions Map — see `_validate_shards` and
    `_acquire_execution_lock` for why each exists.

    For a real per-shard event, `shard` is validated before anything else —
    the Map's shard list is execution input (terraform/eventbridge.tf's
    `range(16)`), not a value baked into the state machine definition, so a
    malformed/adversarial StartExecution could otherwise dispatch a shard
    number outside the real [0, 16) space. collect_history_shard would
    eventually reject it too, but only after this function had already
    built a YouTube client and loaded Creator Master — checking here fails
    before any of that setup cost.

    `reportDate`/`ownerToken` arrive explicitly in the event (the Map's own
    ItemSelector forwards them from AcquireExecutionLock's output) — this
    function never derives its own "today", so it can never disagree with
    the reportDate every other state in this execution is using.
    """
    if "shards" in event:
        return {"shards": _validate_shards(event["shards"])}
    if "validatedShards" in event:
        return _acquire_execution_lock(event)
    shard = _validate_shard(event.get("shard"))
    report_date = date.fromisoformat(event["reportDate"])
    owner_token = event["ownerToken"]
    now = datetime.now(COLLECTION_TIMEZONE)
    bucket_name = os.environ["YOBI_HISTORY_BUCKET"]
    history_store = S3HistoryStore(bucket_name)
    manifest_store = S3TrackingManifestStore(bucket_name)
    dimensions = {
        creator.creator_id: CreatorDimensions(
            organization=creator.organization,
            branch=creator.branch,
        )
        for creator in load_creators()
    }
    result = collect_history_shard(
        youtube=build_youtube_client(get_api_key()),
        manifest_store=manifest_store,
        history_store=history_store,
        collection_date=report_date,
        shard=shard,
        dimensions_by_creator=dimensions,
        observed_at=now.isoformat(),
    )
    partial_key = S3PartialRankingStore(bucket_name).write(
        report_date, shard, result.rankings, result.creator_partials
    )
    # Renewed last, and unconditionally on every success path — including the
    # shard_exists idempotent-skip branch inside collect_history_shard, which
    # never touched YouTube but still fully completed this shard's own work.
    # A failure here (ExecutionLockLostError, this owner's lease already
    # reclaimed by someone else) is deliberately left to propagate: an
    # uncaught exception fails this Task with that exception's own class
    # name, which does not match CollectShard's Retry ErrorEquals list
    # (Lambda.ServiceException/Lambda.TooManyRequestsException/
    # States.TaskFailed — invocation-level errors only), so Step Functions
    # does not waste three more retries on a lock this execution no longer
    # holds — it fails straight to the Map's own Catch.
    execution_lock.renew_execution_lock(
        report_date=report_date,
        owner_token=owner_token,
        now=datetime.now(COLLECTION_TIMEZONE),
        lease_seconds=execution_lock.SHARD_RENEW_LEASE_SECONDS,
        phase=execution_lock.PHASE_COLLECTING,
        completed_shard=shard,
    )
    return {
        "date": report_date.isoformat(),
        "shard": shard,
        "requestedCount": result.requested_count,
        "collectedCount": result.collected_count,
        "skippedCount": len(result.skipped),
        "historyKey": result.history_key,
        "partialRankingKey": partial_key,
    }


def _acquire_execution_lock(event: dict[str, Any]) -> dict[str, Any]:
    """Handle terraform/history.tf's `AcquireExecutionLock` state.

    Canonicalizes this execution's reportDate exactly once
    (execution_lock.canonicalize_report_date) and claims exclusive rights to
    it, so every downstream state can be handed this same value explicitly
    instead of re-deriving it. `executionInput` is the whole original
    StartExecution input (`$$.Execution.Input`), not `$.date`/
    `$.forceRecovery` JSONPaths directly — those fields are optional, and an
    ASL `.$` reference to a key that may not exist fails to resolve; reading
    the whole input object and calling .get() here (not in ASL) is what
    keeps AcquireExecutionLock's own Parameters valid whether or not a
    caller supplied `date`/`forceRecovery`.

    Raises execution_lock.ExecutionLockHeldError (uncaught) when another
    still-valid execution already owns this reportDate —
    terraform/history.tf's own Catch on this state routes that to the
    ExecutionLockHeld Fail state.
    """
    execution_input = event["executionInput"]
    report_date = execution_lock.canonicalize_report_date(execution_input, started_at=event["startedAt"])
    owner_token = event["executionId"]
    execution_lock.acquire_execution_lock(
        report_date=report_date,
        owner_token=owner_token,
        now=datetime.now(COLLECTION_TIMEZONE),
        force_recovery=bool(execution_input.get("forceRecovery", False)),
    )
    return {
        "shards": event["validatedShards"],
        "reportDate": report_date.isoformat(),
        "ownerToken": owner_token,
    }


def _validate_shard(raw: Any) -> int:
    """Parse and validate the event's `shard` value is an integer within [0, HISTORY_SHARD_COUNT).

    A numeric string ("3") is accepted and coerced (Step Functions/JSON may carry
    it either way) — but a bool or a float is rejected outright rather than
    silently truncated (int(1.5) == 1 would otherwise accept a value that was
    never a valid shard number to begin with).
    """
    if raw is None or isinstance(raw, (bool, float)):
        raise ValueError(f"shard is required and must be an integer, got {raw!r}")
    try:
        shard = int(raw)
    except (TypeError, ValueError):
        raise ValueError(f"shard must be an integer, got {raw!r}") from None
    if not 0 <= shard < HISTORY_SHARD_COUNT:
        raise ValueError(f"shard must be within [0, {HISTORY_SHARD_COUNT}), got {shard!r}")
    return shard


def _validate_shards(raw: Any) -> list[int]:
    """Validate a Step Functions Map's whole `shards` execution input before any
    element fans out into its own Task invocation.

    Cost/abuse containment (Roadmap 5.3): terraform/eventbridge.tf's scheduled
    trigger always supplies `range(16)`, but the Map's ItemsPath reads
    `$.shards` from the execution's own input, not a value baked into the
    state machine definition — anyone able to StartExecution this state
    machine (an operator's manual rerun, a compromised credential, a
    scripting mistake) could otherwise supply an arbitrarily long or
    duplicated shards array, e.g. 10,000 repeated entries, and every one of
    them would still fan out into its own Lambda invocation and Step
    Functions state transition before a single one of them ever reached
    _validate_shard/shard_exists to be rejected or short-circuited — that
    per-shard defense bounds YouTube/S3 cost, not Step Functions/Lambda
    invocation count itself. terraform/history.tf runs this as its own state
    ahead of the Map (with no Retry, so a bad array fails the whole
    execution on the first attempt, not three times), so a malformed
    shards array costs exactly one Lambda invocation, never one per
    (garbage) element.

    A subset of the real shard space is accepted (e.g. `[3]`, to manually
    retry one failed shard) — only an empty array, more entries than
    HISTORY_SHARD_COUNT allows for, a duplicate, or any single element
    _validate_shard itself would reject is rejected.
    """
    if not isinstance(raw, list) or not raw:
        raise ValueError(f"shards must be a non-empty array, got {raw!r}")
    if len(raw) > HISTORY_SHARD_COUNT:
        raise ValueError(f"shards must have at most {HISTORY_SHARD_COUNT} entries, got {len(raw)}")
    shards = [_validate_shard(item) for item in raw]
    if len(set(shards)) != len(shards):
        raise ValueError(f"shards must not contain duplicates, got {shards!r}")
    return shards
