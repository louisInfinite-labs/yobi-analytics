"""Exact-anchor growth calculation over freshly collected history rows.

R9 (org-trending retirement): this module used to also provide the old
cross-creator/org-wide "trending" system's bounded Top-N scope-ranking
primitives (CreatorDimensions, RankedGrowth, ScopeKey, top_n_by_scope,
load_exact_anchor_rows, IncrementalRankingMerger, merge_partial_rankings,
_scopes_for, period_values/ALL_PERIOD/PERIODS) -- all removed here, since
their only production consumers (collection.history_worker.collect_
history_shard's ranking/dimensions_by_creator plumbing, api.history_worker_
handler's S3PartialRankingStore write, and analytics.ranking_reducer's
merge/persist_rankings pipeline) were themselves removed once api.read_api.
get_creator_trending/get_organization_trending (the old system's only
readers) were retired.

`exact_gains`/`_period_value`/`UNKNOWN_DISCOVERED_DATE` remain: this is the
shared new-video-baseline rule analytics.video_ranking's own Phase B
calculation reuses unchanged for the still-live per-creator video-ranking
product (see that module's own docstring for why it must not diverge).
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Mapping

from stores.history_store import EXACT_ANCHOR_DAYS, HistoryRow

# The fallback discovered_date for a video _period_value has no real
# discovery-date evidence for (an old manifest entry with no discovered_at,
# or a caller that doesn't track it at all). Deliberately date.min, not
# view_growth_analytics.COLLECTION_START_DATE: COLLECTION_START_DATE
# (2026-08-29) is not guaranteed to be <= every anchor_date this module
# ever computes — during this pipeline's own first 30 days of operation, a
# 30d anchor_date (report_date - 30) can fall *before* COLLECTION_START_DATE,
# which would make an unknown-discovery video satisfy
# "discovered_date > anchor_date" and get misclassified as a new video
# purely because its discovery date wasn't recorded, exactly the "assume
# new because a field is missing" outcome this rule must never produce.
# date.min has no such failure window — it is <= any real calendar date,
# so an unknown discovered_date always resolves to the conservative
# "existing video, real gap" (None) branch, never "new" (baseline 0).
UNKNOWN_DISCOVERED_DATE = date.min


def _period_value(
    *,
    latest_view_count: int,
    anchor_view_count: int | None,
    anchor_date: date,
    discovered_date: date,
) -> int | None:
    """The one shared new-video-baseline rule every period computation in this
    module applies when a specific anchor snapshot is missing (Roadmap 5.x).

    - A real anchor snapshot always wins: latest - anchor. Never touches
      `discovered_date` at all in this case.
    - No anchor, but the video wasn't discovered/tracked until after this
      anchor's own date: the window in question opened after the video
      already had zero history by definition — its baseline for that
      window truly is 0, a genuine fact about a video that didn't exist
      yet, not a fabricated value. This is what lets a video collected for
      only 1-2 days still enter the 7d/30d ranking with its full
      accumulated view count counted as that period's value.
    - No anchor, and the video was already being tracked on or before this
      anchor's date: a real collection gap, not "new" — returns None
      (incomplete) so a caller never silently substitutes 0 or the latest
      count for data that should exist but doesn't.
    """
    if anchor_view_count is not None:
        return latest_view_count - anchor_view_count
    if discovered_date > anchor_date:
        return latest_view_count
    return None


def exact_gains(
    today_rows: list[HistoryRow],
    anchor_rows: Mapping[int, list[HistoryRow]],
    *,
    report_date: date,
    discovered_date_by_video: Mapping[str, date] | None = None,
) -> dict[str, dict[int, int | None]]:
    """Calculate exact gains against each anchor, applying _period_value's shared
    new-video-baseline rule when a specific anchor snapshot is missing.

    `discovered_date_by_video` is deliberately conservative when a video is
    absent from it (an old manifest entry with no recorded discovered_at,
    or a caller that doesn't track it at all): it falls back to
    UNKNOWN_DISCOVERED_DATE (date.min) — never "unknown, so assume new". A
    missing anchor for such a video is always treated as a real gap
    (None), exactly matching this function's pre-existing behavior for any
    caller that doesn't pass discovered_date_by_video at all.
    """
    discovered_date_by_video = discovered_date_by_video or {}
    anchor_counts = {
        days: {row.video_id: row.view_count for row in anchor_rows.get(days, [])}
        for days in EXACT_ANCHOR_DAYS
    }
    anchor_dates = {days: report_date - timedelta(days=days) for days in EXACT_ANCHOR_DAYS}
    return {
        row.video_id: {
            days: _period_value(
                latest_view_count=row.view_count,
                anchor_view_count=anchor_counts[days].get(row.video_id),
                anchor_date=anchor_dates[days],
                discovered_date=discovered_date_by_video.get(row.video_id, UNKNOWN_DISCOVERED_DATE),
            )
            for days in EXACT_ANCHOR_DAYS
        }
        for row in today_rows
    }
