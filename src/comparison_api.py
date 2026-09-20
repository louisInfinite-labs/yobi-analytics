"""Creator comparison data: `GET /dashboard/comparison-data`.

Serves ordered per-creator daily series from the per-creator aggregates the
history pipeline's reducer already persists (`YobiTrendingCache` creatorSummary
items, one per creator, period and completed report date). It performs no
per-video reads: the work depends on the number of creators and dates, never
on how many videos a creator has, and it does not read `YobiSnapshots`.

What each stored aggregate means (history_ranking.creator_period_partials):

- `total-views` <- period `all`, `viewSum`: the sum of each of the creator's
  videos' latest collected view count on that report date.
- `daily-view-growth` <- period `1d`, `viewSum`: the sum of each eligible
  video's exact gain against the previous day's collected count (a real
  anchor, or the pipeline's new-video baseline).

Rules that keep the result honest:

- A report date with no stored aggregate, or one covering no eligible video,
  gets no point (never a fabricated 0).
- A creator that is not in Creator Master is `unavailable` and carries no data.
- A creator whose read fails or whose stored data is malformed is `error`;
  every other creator's data is still returned (partial failure).
- Caller order is preserved end to end: `creatorIds` and `comparisonItemIds`
  are never sorted, and each item's `creators` list follows request order.

Response shape (one entry per requested item, in request order):

    {"reportDate", "timeZone", "windowDays",
     "items": [{"comparisonItemId",
                "creators": [{"creatorId", "status": "ok", "points": [{"label": "YYYY-MM-DD", "value": int}]},
                             {"creatorId", "status": "unavailable" | "error"}]}]}

An item whose requested creators are all known, error-free and without a
single data point returns `"creators": []` -- the empty state, distinct from
a series of zeros.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from typing import Any

import read_api
from dashboard_catalog_api import COMPARISON_ITEMS, ComparisonItemDefinition
from trending_cache_keys import creator_summary_cache_key

if os.environ.get("YOBI_STORAGE_BACKEND") == "dynamodb":
    from dynamodb_store import get_cached_trending
else:
    get_cached_trending = None  # no cache table in local/JSON dev

# Trailing window (in days, ending on reportDate) every series covers.
COMPARISON_WINDOW_DAYS = 7

# Bounded reads (Roadmap 5.3): at most len(periods) x COMPARISON_WINDOW_DAYS
# single-key cache reads per creator.
MAX_COMPARISON_CREATORS = 10

# Metric -> the stored creatorSummary period whose `viewSum` supplies it.
METRICS: dict[str, str] = {
    "daily_view_growth": "1d",
    "total_views": "all",
}

_ITEMS_BY_ID: dict[str, ComparisonItemDefinition] = {item.comparison_item_id: item for item in COMPARISON_ITEMS}


def parse_id_list(raw: Any, *, name: str, max_items: int) -> list[str]:
    """Parse a comma-separated, ordered, duplicate-free ID list, keeping the caller's order."""
    if not isinstance(raw, str) or not raw:
        raise read_api.ClientError(f"{name} is required and must be a non-empty comma-separated string")
    parts = raw.split(",")
    if any(not part or part != part.strip() for part in parts):
        raise read_api.ClientError(f"{name} must not contain empty or whitespace-padded entries: {raw!r}")
    duplicates = sorted({part for part in parts if parts.count(part) > 1})
    if duplicates:
        raise read_api.ClientError(f"{name} must not contain duplicates: {duplicates}")
    if len(parts) > max_items:
        raise read_api.ClientError(f"{name} accepts at most {max_items} entries, got {len(parts)}")
    return parts


def parse_comparison_item_ids(raw: Any) -> list[str]:
    item_ids = parse_id_list(raw, name="comparisonItemIds", max_items=len(_ITEMS_BY_ID))
    unsupported = [item_id for item_id in item_ids if item_id not in _ITEMS_BY_ID]
    if unsupported:
        raise read_api.ClientError(f"Unsupported comparisonItemIds: {unsupported}")
    return item_ids


def get_comparison_data(query: dict[str, Any]) -> dict[str, Any]:
    """Validate a comparison query and return ordered per-item, per-creator series."""
    creator_ids = parse_id_list(query.get("creatorIds"), name="creatorIds", max_items=MAX_COMPARISON_CREATORS)
    item_ids = parse_comparison_item_ids(query.get("comparisonItemIds"))
    report_date = read_api.parse_report_date(query.get("reportDate"))
    time_zone = read_api.parse_time_zone(query.get("timeZone"))

    if get_cached_trending is None:
        raise read_api.RankingNotReadyError("Comparison data is not available: this storage backend has no creator summary cache")

    dates = [report_date - timedelta(days=offset) for offset in range(COMPARISON_WINDOW_DAYS - 1, -1, -1)]
    # One stored aggregate per distinct period, shared by every item that needs it.
    periods = list(dict.fromkeys(METRICS[_ITEMS_BY_ID[item_id].metric] for item_id in item_ids))
    with ThreadPoolExecutor(max_workers=MAX_COMPARISON_CREATORS) as executor:
        outcomes = list(executor.map(lambda creator_id: _creator_outcome(creator_id, dates, periods), creator_ids))
    per_creator = dict(zip(creator_ids, outcomes))

    items = []
    for item_id in item_ids:
        period = METRICS[_ITEMS_BY_ID[item_id].metric]
        creators = [_creator_entry(creator_id, per_creator[creator_id], period, dates) for creator_id in creator_ids]
        if all(entry["status"] == "ok" and not entry["points"] for entry in creators):
            creators = []
        items.append({"comparisonItemId": item_id, "creators": creators})

    return {"reportDate": report_date.isoformat(), "timeZone": time_zone, "windowDays": COMPARISON_WINDOW_DAYS, "items": items}


def _creator_entry(creator_id: str, outcome: dict[str, Any], period: str, dates: list[date]) -> dict[str, Any]:
    if outcome["status"] != "ok":
        return {"creatorId": creator_id, "status": outcome["status"]}
    points = [
        {"label": day.isoformat(), "value": outcome["values"][(period, day)]}
        for day in dates
        if outcome["values"][(period, day)] is not None
    ]
    return {"creatorId": creator_id, "status": "ok", "points": points}


def _creator_outcome(creator_id: str, dates: list[date], periods: list[str]) -> dict[str, Any]:
    """One creator's stored value per (period, date), or why none can be provided.

    A failure here never propagates: it becomes this creator's `error`
    entry so every other requested creator's data is still returned.
    """
    if read_api._find_creator(creator_id) is None:
        return {"status": "unavailable"}
    slots = {(period, day): creator_summary_cache_key(creator_id=creator_id, period=period, report_date=day) for period in periods for day in dates}
    try:
        values = {slot: _summary_value(get_cached_trending(key), creator_id, slot[0], slot[1]) for slot, key in slots.items()}
        return {"status": "ok", "values": values}
    except Exception as exc:  # noqa: BLE001 - deliberate: partial failure must not sink the other creators
        print(f"Comparison data failed for creator {creator_id!r}: {exc!r}")
        return {"status": "error"}


def _summary_value(payload: Any, creator_id: str, period: str, day: date) -> int | None:
    """The stored `viewSum` for one creator/period/date, or None when there is nothing to plot.

    None means no aggregate was stored or it covers no eligible video -- never
    a substitute 0. A payload that does not describe this creator/period/date,
    or whose numbers are not valid counts, is malformed and raises.
    """
    if payload is None:
        return None
    if not isinstance(payload, dict) or (payload.get("creatorId"), payload.get("period"), payload.get("reportDate")) != (creator_id, period, day.isoformat()):
        raise ValueError(f"stored summary does not match {creator_id}/{period}/{day.isoformat()}")
    view_sum, eligible = payload.get("viewSum"), payload.get("eligibleVideoCount")
    for count in (view_sum, eligible):
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ValueError(f"stored summary has an invalid count for {creator_id}/{period}/{day.isoformat()}")
    return view_sum if eligible > 0 else None
