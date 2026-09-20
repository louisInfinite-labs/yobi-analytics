"""Creator comparison data: `GET /dashboard/comparison-data`.

Computes ordered per-creator daily series for backend-supported comparison
items from the same real stored data the rest of the Read API uses (Video
Master and raw daily snapshots), through the same accepted growth
computation (`view_growth_analytics.calculate_growth`, period 1d). It
introduces no second data store and no invented values:

- A date on which a creator has no video with a snapshot on both that date
  and the previous one gets no point (never a fabricated 0).
- A creator that is not in Creator Master is `unavailable` and carries no data.
- A creator whose computation fails is `error`; every other creator's data is
  still returned (partial failure).
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

from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from typing import Any, Callable

import read_api
from dashboard_catalog_api import COMPARISON_ITEMS, ComparisonItemDefinition
from view_growth_analytics import STATUS_OK, GrowthResult, calculate_growth

# Trailing window (in days, ending on reportDate) every series covers -- the
# same week the Read API's own "7d" period reports on.
COMPARISON_WINDOW_DAYS = 7

# Bounded reads only (Roadmap 5.3): each creator costs up to
# _PER_CREATOR_CANDIDATE_CAP videos x (window + 1) snapshot lookups.
MAX_COMPARISON_CREATORS = 10


# Each metric turns one date's OK growth results into that date's value.
METRICS: dict[str, Callable[[list[GrowthResult]], int]] = {
    "daily_view_growth": lambda results: sum(result.growth for result in results),
    "total_views": lambda results: sum(result.latest.view_count for result in results),
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
    """Parse `comparisonItemIds` and reject any ID that is not a supported comparison item."""
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

    dates = [report_date - timedelta(days=offset) for offset in range(COMPARISON_WINDOW_DAYS - 1, -1, -1)]
    with ThreadPoolExecutor(max_workers=read_api._SNAPSHOT_FETCH_WORKERS) as executor:
        per_creator = {creator_id: _creator_outcome(creator_id, dates, executor) for creator_id in creator_ids}

    items = []
    for item_id in item_ids:
        metric = _ITEMS_BY_ID[item_id].metric
        creators = [_creator_entry(creator_id, per_creator[creator_id], metric) for creator_id in creator_ids]
        if all(entry["status"] == "ok" and not entry["points"] for entry in creators):
            creators = []
        items.append({"comparisonItemId": item_id, "creators": creators})

    return {"reportDate": report_date.isoformat(), "timeZone": time_zone, "windowDays": COMPARISON_WINDOW_DAYS, "items": items}


def _creator_entry(creator_id: str, outcome: dict[str, Any], metric: str) -> dict[str, Any]:
    if outcome["status"] != "ok":
        return {"creatorId": creator_id, "status": outcome["status"]}
    compute = METRICS[metric]
    points = [{"label": day.isoformat(), "value": compute(results)} for day, results in outcome["by_date"] if results]
    return {"creatorId": creator_id, "status": "ok", "points": points}


def _creator_outcome(creator_id: str, dates: list[date], executor: ThreadPoolExecutor) -> dict[str, Any]:
    """One creator's OK growth results per date, or why none can be provided.

    A failure here never propagates: it becomes this creator's `error`
    entry so every other requested creator's data is still returned.
    """
    if read_api._find_creator(creator_id) is None:
        return {"status": "unavailable"}
    try:
        return {"status": "ok", "by_date": _daily_ok_results(creator_id, dates, executor)}
    except Exception as exc:  # noqa: BLE001 - deliberate: partial failure must not sink the other creators
        print(f"Comparison data failed for creator {creator_id!r}: {exc!r}")
        return {"status": "error"}


def _daily_ok_results(creator_id: str, dates: list[date], executor: ThreadPoolExecutor) -> list[tuple[date, list[GrowthResult]]]:
    videos = [video for video in read_api.get_videos_by_creator(creator_id) if video.activity_state != "Cold"]
    videos = read_api._rank_and_cap_candidates(videos, cap=read_api._PER_CREATOR_CANDIDATE_CAP)
    snapshot_dates = [dates[0] - timedelta(days=1), *dates]
    lookups = [(video, snapshot_date) for video in videos for snapshot_date in snapshot_dates]
    fetched = list(executor.map(lambda pair: read_api.get_snapshot(pair[0].video_id, pair[1]), lookups))
    snapshots = {(video.video_id, snapshot_date): snapshot for (video, snapshot_date), snapshot in zip(lookups, fetched)}

    by_date: list[tuple[date, list[GrowthResult]]] = []
    for day in dates:
        ok_results = []
        for video in videos:
            result = calculate_growth(
                video_id=video.video_id,
                report_date=day,
                period="1d",
                latest_snapshot=snapshots[(video.video_id, day)],
                comparison_snapshot=snapshots[(video.video_id, day - timedelta(days=1))],
                earliest_available_date=read_api._earliest_available_date_for(video),
            )
            if result.status == STATUS_OK:
                ok_results.append(result)
        by_date.append((day, ok_results))
    return by_date
