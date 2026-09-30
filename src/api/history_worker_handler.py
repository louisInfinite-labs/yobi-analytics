"""Lambda entry point for one deterministic daily history shard."""

from __future__ import annotations

import os
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from stores import dynamodb_store
from collection import execution_lock
from ops.config import get_api_key
from tracking.creator_master import get_active_creators
from stores.history_store import HISTORY_SHARD_COUNT, S3HistoryStore
from collection.history_worker import collect_history_shard
from tracking.tracking_manifest import S3TrackingManifestStore
from collection.youtube_client import QuotaExhaustedError, build_youtube_client
from collection.subscriber_snapshot import collect_subscriber_snapshot_if_missing
from stores.subscriber_history_store import S3SubscriberHistoryStore, SubscriberHistoryStoreError
from analytics.subscriber_ranking import load_exact_anchor_subscriber_rows
from analytics.subscriber_ranking_result import build_subscriber_ranking_result
from stores.subscriber_ranking_store import S3SubscriberRankingStore, SubscriberRankingStoreError

COLLECTION_TIMEZONE = ZoneInfo("Asia/Tokyo")


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Collect one shard and persist its history.

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

    `video_master_store=dynamodb_store` (the module itself, not a wrapper
    instance — its module-level `get_video`/`upsert_videos` already match
    `video_master.VideoMasterStore`'s shape) restores classify_after_
    observation's scheduler-state write-back for Phase B (Roadmap 1.5),
    using this Lambda's existing `local.lambda_role_arn` — the same
    production role `collector` already writes Video Master under today, so
    no new IAM grant is required for this.

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
    result = collect_history_shard(
        youtube=build_youtube_client(get_api_key()),
        manifest_store=manifest_store,
        history_store=history_store,
        video_master_store=dynamodb_store,
        collection_date=report_date,
        shard=shard,
        observed_at=now.isoformat(),
    )
    # Renewed last, and unconditionally on every success path — including the
    # shard_exists idempotent-skip branch inside collect_history_shard, which
    # never touched YouTube but still fully completed this shard's own work.
    # A failure here (ExecutionLockLostError, this owner's lease already
    # reclaimed by someone else) is deliberately left to propagate: an
    # uncaught exception fails this Task with that exception's own class
    # name, which does not match CollectShard's Retry ErrorEquals list
    # (Lambda.ServiceException/Lambda.AWSLambdaException/
    # Lambda.SdkClientException/Lambda.TooManyRequestsException —
    # invocation-level errors only), so Step Functions does not waste three
    # more retries on a lock this execution no longer holds — it fails
    # straight to the Map's own Catch.
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
    _collect_subscriber_snapshot_if_configured(report_date)
    return {
        "shards": event["validatedShards"],
        "reportDate": report_date.isoformat(),
        "ownerToken": owner_token,
    }


def _collect_subscriber_snapshot_if_configured(report_date: date) -> None:
    """Best-effort daily subscriber-history collection (R3) AND subscriber-
    leaderboard result build (R4), run from inside AcquireExecutionLock -- a
    single Task in terraform/history.tf's state machine, reached exactly
    once per execution before CollectHistoryShards' 16-way Map ever fans
    out. This is what makes both steps run once per report date, never once
    per shard: nothing below is reachable from CollectShard's own per-shard
    code path in this same module, and AcquireExecutionLock itself has no
    loop/Map around it. R4's ranking build runs strictly AFTER the snapshot
    step, in the same invocation -- it reads back whatever the snapshot step
    just left in S3 (freshly collected, repaired, or already-complete),
    never a stale in-memory copy from before that step ran.

    A failure anywhere below is deliberately never allowed to propagate.
    Subscriber history/ranking is a separate, independently-idempotent-and-
    repairing concern from the video-history pipeline this Lambda exists to
    run -- a subscriber-only problem (YouTube quota exhaustion, a transient
    network/API error, an S3 write failure on either the history or the
    ranking-result object) must never turn into a failed AcquireExecutionLock
    Task, which would abort this execution before CollectHistoryShards even
    starts and block real video-history collection for something unrelated
    to it. Every branch below only ever prints a Warning and returns; none
    of them re-raise.

    `os.environ["YOBI_HISTORY_BUCKET"]` is read first, before building a
    YouTube client or loading Creator Master, so a bare/misconfigured
    environment (e.g. an existing test exercising the acquire branch without
    wiring any of this up) fails this fast and cheaply rather than after
    already paying for that setup.
    """
    try:
        bucket_name = os.environ["YOBI_HISTORY_BUCKET"]
        creators = get_active_creators()
        youtube = build_youtube_client(get_api_key())
        history_store = S3SubscriberHistoryStore(bucket_name)
        now = datetime.now(COLLECTION_TIMEZONE)
        key, skip_reasons, collected = collect_subscriber_snapshot_if_missing(
            youtube,
            creators,
            collection_date=report_date,
            observed_at=now.isoformat(),
            store=history_store,
        )
        if collected:
            print(
                f"Subscriber snapshot collected/repaired for reportDate={report_date.isoformat()}: "
                f"key={key}, roster={len(creators)}, stillMissing={len(skip_reasons)}"
            )
        elif skip_reasons:
            print(
                f"Subscriber snapshot attempted but recovered nothing new for "
                f"reportDate={report_date.isoformat()}: roster={len(creators)}, "
                f"stillMissing={len(skip_reasons)} -- no S3 write, remains repairable"
            )
        else:
            print(
                f"Subscriber snapshot already complete for reportDate={report_date.isoformat()}; "
                "skipped collection"
            )

        _build_and_persist_subscriber_ranking(
            report_date=report_date,
            generated_at=now.isoformat(),
            creators=creators,
            history_store=history_store,
            bucket_name=bucket_name,
        )
    except QuotaExhaustedError as exc:
        print(
            f"Warning: subscriber snapshot skipped, YouTube quota exhausted for "
            f"reportDate={report_date.isoformat()}: {exc}"
        )
    except SubscriberHistoryStoreError as exc:
        print(
            f"Warning: subscriber snapshot S3 write failed for "
            f"reportDate={report_date.isoformat()}: {exc}"
        )
    except SubscriberRankingStoreError as exc:
        print(
            f"Warning: subscriber ranking result S3 write failed for "
            f"reportDate={report_date.isoformat()}: {exc}"
        )
    except Exception as exc:  # noqa: BLE001 -- deliberate: see this function's own docstring
        print(
            f"Warning: subscriber snapshot/ranking collection failed unexpectedly for "
            f"reportDate={report_date.isoformat()}: {exc}"
        )


def _build_and_persist_subscriber_ranking(
    *, report_date: date, generated_at: str, creators, history_store: S3SubscriberHistoryStore, bucket_name: str
) -> None:
    """R4: build the subscriber-leaderboard result from whatever is now
    persisted at subscriber-history/date={report_date} (read fresh here,
    never trusted from an in-memory value computed before the snapshot
    step's own collect/repair just ran) plus the exact D-1/D-7/D-30 anchors,
    and deterministically overwrite subscriber-ranking/date={report_date} --
    a same-date rebuild after R3 repairs a partial snapshot simply replaces
    the same key, never "result exists -> skip forever" (see
    S3SubscriberRankingStore.write_result's own docstring).

    Never writes when D0 has no usable current observations at all
    (build_subscriber_ranking_result returns None in that case) -- this
    naturally covers a total subscriber-collection failure too, without any
    special-case branching here: an empty/absent history snapshot simply
    produces an empty `total` list.
    """
    current_rows = history_store.read_daily_snapshot(report_date)
    anchor_rows_by_days = load_exact_anchor_subscriber_rows(history_store, report_date=report_date)
    result = build_subscriber_ranking_result(
        report_date=report_date,
        generated_at=generated_at,
        current_rows=current_rows,
        anchor_rows_by_days=anchor_rows_by_days,
        creators=creators,
    )
    if result is None:
        print(
            f"Subscriber ranking result skipped for reportDate={report_date.isoformat()}: "
            "no usable current observations"
        )
        return
    ranking_store = S3SubscriberRankingStore(bucket_name)
    ranking_key = ranking_store.write_result(report_date, result)
    print(f"Subscriber ranking result written for reportDate={report_date.isoformat()}: key={ranking_key}")


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
