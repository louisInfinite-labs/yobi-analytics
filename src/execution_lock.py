"""Cross-invocation mutual exclusion for one daily history execution (Roadmap 5.x).

One row per reportDate in YobiHistoryExecutionLock guards the whole
Validate -> AcquireExecutionLock -> CollectHistoryShards -> ReduceRankings ->
MarkExecutionComplete pipeline against a second execution for the *same*
reportDate running concurrently -- whether that's a duplicate scheduled
trigger, an operator's manual retry racing the original run, or a crashed
execution that never released its own claim. Reducer-only locking would
still leave duplicate YouTube calls and duplicate S3 shard writes
unprotected (the two costliest failure modes), so this lock is acquired
before CollectHistoryShards' own Map fan-out ever begins, not just around
the reducer.

Every write here is a single conditional PutItem/UpdateItem -- never a
read-then-write -- so ownership can never be split between two callers that
both observed the same "not locked" snapshot. `expiresAt` (a DynamoDB
Number, Unix epoch seconds) is the *only* authoritative lease deadline;
`status`/`currentPhase` are for observability, never consulted by
acquire's own mutual-exclusion logic on their own. Every renew/complete/
failed write additionally requires `ownerToken = :mine` (and renew also
`status = IN_PROGRESS`) -- once a lease has been reclaimed by a new owner,
the old owner's own ownerToken can never match that condition again, so a
crashed execution's late cleanup attempt can never clobber whoever holds
the lock now.
"""

from __future__ import annotations

import os
import re
import threading
from datetime import date, datetime
from typing import Any, NoReturn
from zoneinfo import ZoneInfo

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

EXECUTION_LOCK_TABLE = os.environ.get("YOBI_EXECUTION_LOCK_TABLE") or "YobiHistoryExecutionLock"

STATUS_IN_PROGRESS = "IN_PROGRESS"
STATUS_COMPLETE = "COMPLETE"
STATUS_FAILED = "FAILED"

PHASE_COLLECTING = "COLLECTING"
PHASE_REDUCING = "REDUCING"
PHASE_COMPLETE = "COMPLETE"
PHASE_FAILED = "FAILED"

# Confirmed execution-lock design: the worst-case single-shard CollectShard
# Task duration under its own Step Functions Retry (1 original attempt + 3
# retries, IntervalSeconds=30/BackoffRate=2) is
# 4*900s + 30s + 60s + 120s = 3810s (~63.5 min). 90 minutes leaves ~26.5
# minutes of margin between any two consecutive per-shard renewals, so the
# lock survives as long as shards keep completing -- it no longer needs to
# be sized to the whole Map's own multi-hour pathological total.
ACQUIRE_LEASE_SECONDS = 90 * 60
SHARD_RENEW_LEASE_SECONDS = 90 * 60
# Reducer has no Retry and a 900s Lambda timeout -- 45 minutes leaves
# generous margin for ReduceRankings plus the MarkExecutionComplete/Failed
# state that follows it, without needing a second renewal inside that tail.
REDUCER_RENEW_LEASE_SECONDS = 45 * 60

# COMPLETE/FAILED rows are never deleted by this module -- see
# mark_execution_complete's own docstring for why. ttlAt schedules DynamoDB's
# own background TTL sweep ~30 days later, purely for housekeeping; it is
# never consulted by acquire_execution_lock's mutual-exclusion logic.
COMPLETE_RETENTION_SECONDS = 30 * 24 * 60 * 60

_MAX_LAST_ERROR_LENGTH = 500

_thread_local = threading.local()


class ExecutionLockError(Exception):
    """Base for every execution_lock failure."""


class ExecutionLockHeldError(ExecutionLockError):
    """Raised by acquire_execution_lock: another still-valid owner already
    holds this reportDate's lock (or it's COMPLETE and force_recovery wasn't
    set). The caller must not retry this same acquire call in a loop --
    Step Functions' own Catch on this error is the intended response."""


class ExecutionLockLostError(ExecutionLockError):
    """Raised by renew_execution_lock/mark_execution_complete/
    mark_execution_failed: this caller's ownerToken no longer matches the
    row (a takeover already happened) or the row is no longer IN_PROGRESS.
    The caller must treat itself as no longer holding the lock and must
    never retry the same call expecting it to eventually succeed -- a lease
    reclaimed by a new owner will never match the old ownerToken again."""


def _resource():
    """This thread's own cached boto3 DynamoDB resource -- see
    dynamodb_store._resource's own docstring for why Resource/Session
    instances are cached per-thread rather than process-wide or per-call."""
    resource = getattr(_thread_local, "dynamodb_resource", None)
    if resource is None:
        session = boto3.session.Session()
        resource = session.resource("dynamodb", config=Config(max_pool_connections=110))
        _thread_local.dynamodb_resource = resource
    return resource


def _table():
    return _resource().Table(EXECUTION_LOCK_TABLE)


def _raise_if_conditional_check_failed(exc: ClientError, error_cls: type[ExecutionLockError], message: str) -> NoReturn:
    if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
        raise error_cls(message) from None
    raise ExecutionLockError(f"{EXECUTION_LOCK_TABLE} operation failed: {exc}") from exc


def _sanitize_error_message(message: str) -> str:
    """Collapse to one line and cap length, so an arbitrarily large Step
    Functions error payload (a stack-trace-shaped Cause, for example) never
    risks DynamoDB's own item-size limits and stays readable for a future
    admin read of `lastError`."""
    collapsed = re.sub(r"\s+", " ", str(message)).strip()
    if len(collapsed) > _MAX_LAST_ERROR_LENGTH:
        return collapsed[: _MAX_LAST_ERROR_LENGTH - 1] + "…"
    return collapsed


def canonicalize_report_date(
    execution_input: dict[str, Any], *, started_at: str, time_zone: str = "Asia/Tokyo"
) -> date:
    """Compute this execution's reportDate exactly once.

    Every downstream state (CollectHistoryShards' Map, ReduceRankings, this
    lock's own row, every trending_cache_keys.* cache key) must be handed
    this same value explicitly afterward -- never re-derive it -- so an
    execution that happens to straddle midnight Asia/Tokyo can't disagree
    with itself about which day it's collecting for.

    An explicit `date` in execution_input (a manual/repair rerun targeting
    one specific past day) always wins; otherwise the execution's own start
    time, converted to `time_zone`, is used -- the same "now in Asia/Tokyo"
    convention a fresh scheduled run has always used.
    """
    explicit = execution_input.get("date")
    if explicit:
        return date.fromisoformat(explicit)
    started = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
    return started.astimezone(ZoneInfo(time_zone)).date()


def acquire_execution_lock(
    *,
    report_date: date,
    owner_token: str,
    now: datetime,
    lease_seconds: int = ACQUIRE_LEASE_SECONDS,
    force_recovery: bool = False,
) -> None:
    """Claim exclusive rights to run the whole daily history execution for
    report_date, or raise ExecutionLockHeldError.

    A blind conditional PutItem (never read-then-write) replaces the whole
    row -- including resetting completedShards/lastError from any prior
    attempt for this same reportDate -- since a fresh owner always starts a
    fresh COLLECTING phase, regardless of what an earlier row for the same
    date happened to record.

    Acquire rules (confirmed execution-lock design):
      - no row yet                          -> allowed
      - IN_PROGRESS, expiresAt > now        -> rejected, always (repair mode
                                                does not override a still-live
                                                execution either)
      - IN_PROGRESS, expiresAt <= now       -> allowed (crash takeover)
      - FAILED                              -> allowed (a failed day is
                                                expected to be retried,
                                                automatically or manually,
                                                without needing force_recovery)
      - COMPLETE                            -> rejected unless
                                                force_recovery=True
    """
    now_epoch = int(now.timestamp())
    expires_at = now_epoch + lease_seconds
    condition = (
        "attribute_not_exists(reportDate)"
        " OR #status = :failed"
        " OR (#status = :in_progress AND expiresAt <= :now)"
    )
    if force_recovery:
        condition += " OR #status = :complete"
    try:
        _table().put_item(
            Item={
                "reportDate": report_date.isoformat(),
                "ownerToken": owner_token,
                "status": STATUS_IN_PROGRESS,
                "currentPhase": PHASE_COLLECTING,
                "expiresAt": expires_at,
                "acquiredAt": now.isoformat(),
                "renewedAt": now.isoformat(),
            },
            ConditionExpression=condition,
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":failed": STATUS_FAILED,
                ":in_progress": STATUS_IN_PROGRESS,
                ":complete": STATUS_COMPLETE,
                ":now": now_epoch,
            },
        )
    except ClientError as exc:
        _raise_if_conditional_check_failed(
            exc,
            ExecutionLockHeldError,
            f"{EXECUTION_LOCK_TABLE} lock for reportDate {report_date.isoformat()!r} is already held",
        )


def renew_execution_lock(
    *,
    report_date: date,
    owner_token: str,
    now: datetime,
    lease_seconds: int,
    phase: str,
    completed_shard: int | None = None,
) -> None:
    """Extend this owner's lease to now + lease_seconds, and -- when
    completed_shard is given -- record that shard as done.

    `ADD completedShards {completed_shard}` is a DynamoDB Number Set add: a
    shard number already present is a no-op, not a duplicate, so a Step
    Functions Retry of the same CollectShard Task (same shard, same owner)
    renewing twice never inflates anything -- there is no separate
    completedShardCount to keep consistent; a future reader computes it as
    len(completedShards).

    Raises ExecutionLockLostError if this owner_token no longer matches the
    row, or the row is no longer IN_PROGRESS.
    """
    now_epoch = int(now.timestamp())
    expires_at = now_epoch + lease_seconds
    update_expression = "SET expiresAt = :expiresAt, renewedAt = :renewedAt, currentPhase = :phase"
    values: dict[str, Any] = {
        ":owner": owner_token,
        ":in_progress": STATUS_IN_PROGRESS,
        ":expiresAt": expires_at,
        ":renewedAt": now.isoformat(),
        ":phase": phase,
    }
    if completed_shard is not None:
        update_expression += " ADD completedShards :completedShard"
        values[":completedShard"] = {completed_shard}
    try:
        _table().update_item(
            Key={"reportDate": report_date.isoformat()},
            UpdateExpression=update_expression,
            ConditionExpression="ownerToken = :owner AND #status = :in_progress",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues=values,
        )
    except ClientError as exc:
        _raise_if_conditional_check_failed(
            exc,
            ExecutionLockLostError,
            f"{EXECUTION_LOCK_TABLE} lock for reportDate {report_date.isoformat()!r} is no longer held by {owner_token!r}",
        )


def mark_execution_complete(*, report_date: date, owner_token: str, now: datetime) -> None:
    """Mark this reportDate's execution COMPLETE -- never deletes the row.

    A COMPLETE row stays in place specifically so acquire_execution_lock
    rejects a normal (non-repair) execution for the same reportDate outright,
    rather than silently re-running the reducer a second time for a day
    that already finished. ttlAt schedules this row for DynamoDB's own
    background TTL cleanup ~30 days later -- housekeeping only.
    """
    now_epoch = int(now.timestamp())
    try:
        _table().update_item(
            Key={"reportDate": report_date.isoformat()},
            UpdateExpression=(
                "SET #status = :complete, currentPhase = :complete, "
                "completedAt = :completedAt, ttlAt = :ttlAt"
            ),
            ConditionExpression="ownerToken = :owner AND #status = :in_progress",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":owner": owner_token,
                ":in_progress": STATUS_IN_PROGRESS,
                ":complete": STATUS_COMPLETE,
                ":completedAt": now.isoformat(),
                ":ttlAt": now_epoch + COMPLETE_RETENTION_SECONDS,
            },
        )
    except ClientError as exc:
        _raise_if_conditional_check_failed(
            exc,
            ExecutionLockLostError,
            f"{EXECUTION_LOCK_TABLE} lock for reportDate {report_date.isoformat()!r} is no longer held by {owner_token!r}",
        )


def mark_execution_failed(*, report_date: date, owner_token: str, now: datetime, error_message: str) -> None:
    """Mark this reportDate's execution FAILED -- never deletes the row.

    Unlike COMPLETE, acquire_execution_lock always allows a normal (non-
    repair) re-acquire once status is FAILED: a failed day never finished,
    so retrying it -- automatically via the next manual/scheduled attempt --
    is the intended recovery path, not something that needs force_recovery.

    Raises ExecutionLockLostError the same way renew/mark_execution_complete
    do if this owner's lease was already reclaimed by someone else -- the
    ASL Catch on the MarkExecutionFailed state (not this function) is what
    guarantees the pipeline still reaches its terminal Fail state either way.
    """
    now_epoch = int(now.timestamp())
    try:
        _table().update_item(
            Key={"reportDate": report_date.isoformat()},
            UpdateExpression=(
                "SET #status = :failed, currentPhase = :failed, "
                "completedAt = :completedAt, ttlAt = :ttlAt, lastError = :lastError"
            ),
            ConditionExpression="ownerToken = :owner AND #status = :in_progress",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":owner": owner_token,
                ":in_progress": STATUS_IN_PROGRESS,
                ":failed": STATUS_FAILED,
                ":completedAt": now.isoformat(),
                ":ttlAt": now_epoch + COMPLETE_RETENTION_SECONDS,
                ":lastError": _sanitize_error_message(error_message),
            },
        )
    except ClientError as exc:
        _raise_if_conditional_check_failed(
            exc,
            ExecutionLockLostError,
            f"{EXECUTION_LOCK_TABLE} lock for reportDate {report_date.isoformat()!r} is no longer held by {owner_token!r}",
        )
