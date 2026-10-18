"""DynamoDB-backed read access to the Creator Milestones table (YobiCreatorMilestones).

One item per Creator Master creatorId: {creatorId, birthday "MM-DD" (no year), debutDate "YYYY-MM-DD"} -- a creator's birthday and
ORIGINAL debut date, kept for graduated creators too. The backend only READS it: one creator with a single GetItem on the partition key, or the whole
roster (~110 tiny items) with ONE paginated Scan that is cached in the Lambda execution environment (see get_all_creator_milestones). The table is
seeded by scripts/migration/seed_creator_milestones_dynamodb.py and nothing in the application writes to it. The dates are fixed facts; every
countdown or anniversary number is computed by the frontend.
"""

from __future__ import annotations

import os
import time
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

CREATOR_MILESTONES_TABLE = os.environ.get("YOBI_CREATOR_MILESTONES_TABLE") or "YobiCreatorMilestones"


class CreatorMilestonesStoreError(Exception):
    """Raised when the Creator Milestones table is unreachable or an item in it is malformed."""


_cached_resource = None


def _resource():
    """Return a cached boto3 DynamoDB resource, using the ambient AWS credentials/region.

    See client_credential_store.py's own _resource() for why this is cached at module level rather than constructed per call.
    """
    global _cached_resource
    if _cached_resource is None:
        _cached_resource = boto3.resource("dynamodb")
    return _cached_resource


def get_creator_milestones(creator_id: str) -> dict[str, Any] | None:
    """Return {creatorId, birthday, debutDate} for one creator, or None when the table has no item for that id.

    A single GetItem. Raises CreatorMilestonesStoreError when DynamoDB cannot be reached or the stored item lacks a string birthday or
    debutDate -- a malformed item is never passed on as if it were data.
    """
    try:
        item = _resource().Table(CREATOR_MILESTONES_TABLE).get_item(Key={"creatorId": creator_id}).get("Item")
    except (ClientError, BotoCoreError) as exc:
        raise CreatorMilestonesStoreError(f"Failed to read {CREATOR_MILESTONES_TABLE}: {exc}") from exc
    if item is None:
        return None
    birthday, debut_date = item.get("birthday"), item.get("debutDate")
    if not isinstance(birthday, str) or not isinstance(debut_date, str):
        raise CreatorMilestonesStoreError(f"{CREATOR_MILESTONES_TABLE} item for {creator_id!r} lacks a string birthday or debutDate")
    return {"creatorId": creator_id, "birthday": birthday, "debutDate": debut_date}


# --- Bulk read for the Live Status list: GET /milestones ------------------------------------------------------------------------------
#
# The whole roster in one read. The result is cached at module level, the same way api/livestream_classification.py and api/provisional_discoveries.py cache
# (a monotonic-clock TTL, clear_cache() for tests). IMPORTANT LIMITATION: this cache lives in ONE Lambda execution environment, not globally -- every cold
# start, and every additional concurrent environment, scans once for itself, and an environment that stays idle is eventually reclaimed with its cache. The
# cache therefore bounds the cost (at most about one Scan per environment per TTL) but does not make it exactly one. The dates are fixed facts, so a TTL of an
# hour only delays a corrected date by up to an hour.
_ALL_TTL_SECONDS = 3600.0

_all_cache: tuple[float, list[dict[str, str]]] | None = None


def clear_cache() -> None:
    """Forget the cached roster (tests, and an explicit refresh)."""
    global _all_cache
    _all_cache = None


def _scan_all_items() -> list[dict[str, Any]]:
    """Every item, following LastEvaluatedKey until DynamoDB reports no more pages (one page is at most 1 MB, far above the roster)."""
    table = _resource().Table(CREATOR_MILESTONES_TABLE)
    items: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {"ProjectionExpression": "creatorId, birthday, debutDate"}
    while True:
        response = table.scan(**kwargs)
        items.extend(response.get("Items", []))
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            return items
        kwargs["ExclusiveStartKey"] = last_key


def get_all_creator_milestones(now: float | None = None) -> list[dict[str, str]]:
    """Every creator's {creatorId, birthday, debutDate}, sorted by creatorId, served from the warm-Lambda cache while it is fresh.

    A cache hit performs no DynamoDB call at all. On a miss (cold environment or an expired TTL) one paginated Scan reads the whole table. An item without a
    string creatorId, birthday and debutDate is skipped with a warning rather than passed on or allowed to hide the rest. A failed Scan raises
    CreatorMilestonesStoreError and is NOT cached, so the next request tries again.
    """
    global _all_cache
    moment = time.monotonic() if now is None else now
    if _all_cache is not None and _all_cache[0] > moment:
        return _all_cache[1]
    try:
        items = _scan_all_items()
    except (ClientError, BotoCoreError) as exc:
        raise CreatorMilestonesStoreError(f"Failed to scan {CREATOR_MILESTONES_TABLE}: {exc}") from exc
    records: list[dict[str, str]] = []
    for item in items:
        creator_id, birthday, debut_date = item.get("creatorId"), item.get("birthday"), item.get("debutDate")
        if not all(isinstance(value, str) and value for value in (creator_id, birthday, debut_date)):
            print(f"Warning: skipping a malformed {CREATOR_MILESTONES_TABLE} item: {sorted(item)}")
            continue
        records.append({"creatorId": creator_id, "birthday": birthday, "debutDate": debut_date})
    records.sort(key=lambda record: record["creatorId"])
    _all_cache = (moment + _ALL_TTL_SECONDS, records)
    return records
