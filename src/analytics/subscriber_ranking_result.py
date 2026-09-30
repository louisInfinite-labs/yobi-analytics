"""Build the daily subscriber-leaderboard JSON RESULT payload (ranking-
simplification, R4) from R2's pure calculation
(analytics.subscriber_ranking.build_subscriber_leaderboards) plus R1/R3's
daily subscriber-history snapshots.

Purely a builder -- no S3, no boto3, no persistence dependency at all (see
stores.subscriber_ranking_store for the S3-only writer this feeds). R2's own
calculation module (analytics/subscriber_ranking.py) is intentionally left
unmodified: this is a separate, additive layer on top of it, not a change to
R2's own accepted contract.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Mapping

from analytics.subscriber_ranking import (
    GROWTH_PERIODS,
    SubscriberGrowthRow,
    TotalSubscribersRow,
    build_subscriber_leaderboards,
    dimensions_from_creators,
)
from stores.subscriber_history_store import SubscriberRow
from tracking.creator_master import Creator


def build_subscriber_ranking_result(
    *,
    report_date: date,
    generated_at: str,
    current_rows: list[SubscriberRow],
    anchor_rows_by_days: Mapping[int, list[SubscriberRow]],
    creators: list[Creator],
) -> dict[str, Any] | None:
    """Build the one-object-per-report-date result payload, or None when D0
    has no usable current observations at all.

    Returns None rather than persisting an empty/misleading result (see
    this module's own R4 report for why "skip" was chosen over "persist an
    explicit error-status object": consistent with R3's own established
    "nothing recovered -> no S3 write" convention in this exact R-sequence,
    and there is no reader yet -- R4 stops before any API/frontend exists to
    need a status field) -- the caller is expected to log this and simply
    not call the S3 store's write_result in that case.

    `creators` is the SAME authoritative roster R2's own build_subscriber_
    leaderboards already requires (dimensions_by_creator, derived here via
    dimensions_from_creators) -- never a second/independent roster.
    expectedCreatorCount/observedCreatorCount/missingCreatorCount are
    computed from that same roster intersected with which roster creators
    have ANY row (visible or hidden) in `current_rows`, independent of
    per-metric eligibility (R2's own ineligible dicts already cover that at
    the metric level).
    """
    dimensions_by_creator = dimensions_from_creators(creators)
    leaderboards = build_subscriber_leaderboards(
        current_rows, anchor_rows_by_days, dimensions_by_creator=dimensions_by_creator
    )

    if not leaderboards.total:
        return None

    roster_creator_ids = {creator.creator_id for creator in creators}
    observed_creator_ids = {row.creator_id for row in current_rows} & roster_creator_ids
    expected_count = len(roster_creator_ids)
    observed_count = len(observed_creator_ids)

    result: dict[str, Any] = {
        "reportDate": report_date.isoformat(),
        "generatedAt": generated_at,
        "expectedCreatorCount": expected_count,
        "observedCreatorCount": observed_count,
        "missingCreatorCount": expected_count - observed_count,
        "total": {
            "rows": [_serialize_total_row(row) for row in leaderboards.total],
            "ineligible": dict(leaderboards.total_ineligible),
        },
    }
    for period in GROWTH_PERIODS:
        result[period] = {
            "rows": [_serialize_growth_row(row) for row in leaderboards.growth[period]],
            "ineligible": dict(leaderboards.growth_ineligible[period]),
        }
    return result


def _serialize_total_row(row: TotalSubscribersRow) -> dict[str, Any]:
    return {
        "rank": row.rank,
        "creatorId": row.creator_id,
        "organization": row.organization,
        "subscriberCount": row.subscriber_count,
    }


def _serialize_growth_row(row: SubscriberGrowthRow) -> dict[str, Any]:
    return {
        "rank": row.rank,
        "creatorId": row.creator_id,
        "organization": row.organization,
        "currentSubscriberCount": row.current_subscriber_count,
        "anchorSubscriberCount": row.anchor_subscriber_count,
        "absoluteGrowth": row.absolute_growth,
        # R2's own float, unrounded -- no second percentage convention here.
        "percentageGrowth": row.percentage_growth,
    }
