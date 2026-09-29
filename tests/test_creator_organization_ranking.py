"""Success-path tests for the shared exact-anchor/new-video-baseline rule
(history_ranking._period_value) that period_values/exact_gains/top_n_by_scope
all build on.

Scope (per the current round): normal-case aggregation/reduction only —
malicious/malformed input is deliberately out of scope here. The one
"abnormal-looking but actually routine" case explicitly in scope is a
newly-discovered video with no D-7/D-30 anchor yet — that happens every
real day, not just as an edge case, so it gets full coverage below
alongside the historical "real gap, not new" case it must be told apart
from (history_ranking._period_value).

R7 (AWS Cost Recovery): the organization_creator_leaderboards (orgLeaderboard
producer) and creator_topic_partials/topic_creator_leaderboards (topic
leaderboard producer) test sections that used to live in this file were
removed along with the zero-consumer endpoints/producers they covered. R8B
(AWS Cost Recovery): the creator_period_partials/merge_creator_period_partials
test sections were removed the same way, once creatorSummary (their only
production consumer) was retired -- see test_ranking_reducer.py/test_ranking_
partial_store.py for that removal's own coverage.
"""

from datetime import date, timedelta

from analytics.history_ranking import (
    ALL_PERIOD,
    UNKNOWN_DISCOVERED_DATE,
    exact_gains,
    period_values,
    top_n_by_scope,
)
from stores.history_store import HistoryRow
from tracking.tracking_manifest import ManifestEntry, discovered_dates_by_video

REPORT_DATE = date(2026, 9, 9)


def _history_row(video_id, count, creator_id="c1"):
    return HistoryRow(
        video_id=video_id,
        creator_id=creator_id,
        view_count=count,
        observed_at="2026-09-09T18:00:00+09:00",
        availability_status="available",
    )


# --- the shared new-video-baseline rule (period_values/exact_gains/top_n_by_scope) --


def test_period_values_growth_periods_match_exact_gains_when_an_anchor_exists():
    """A real anchor always wins, regardless of discovered_date -- the normal case."""
    today = [_history_row("v1", 1_000)]
    anchors = {1: [_history_row("v1", 900)], 7: [_history_row("v1", 700)], 30: [_history_row("v1", 100)]}
    values = period_values(today, anchors, report_date=REPORT_DATE)
    assert values["v1"] == {"1d": 100, "7d": 300, "30d": 900, "all": 1_000}


def test_period_values_all_is_the_latest_view_count_with_no_anchor_needed():
    """"all" never needs a historical anchor -- it must still resolve even
    when every anchor window is completely empty (a brand-new video, or day
    2 of collection when D-7/D-30 can't exist yet)."""
    today = [_history_row("v1", 500)]
    values = period_values(today, {1: [], 7: [], 30: []}, report_date=REPORT_DATE)
    assert values["v1"][ALL_PERIOD] == 500


def test_new_video_within_the_window_gets_zero_baseline_and_enters_7d_30d_ranking():
    """A video discovered today (this collection run is its first) has no
    D-1/D-7/D-30 anchor -- not because of a collection failure, but because
    every one of those windows opened before the video existed. Its full
    latest view count must still count as every period's value, and it must
    still be rankable (this is the routine "new video today" case, not an
    edge case)."""
    discovered = {"new_video": REPORT_DATE}  # discovered on this very collection run
    today = [_history_row("new_video", 50_000, creator_id="c1")]
    anchors = {1: [], 7: [], 30: []}  # genuinely never existed on any of these dates

    values = period_values(today, anchors, report_date=REPORT_DATE, discovered_date_by_video=discovered)
    assert values["new_video"] == {"1d": 50_000, "7d": 50_000, "30d": 50_000, "all": 50_000}

    ranked = top_n_by_scope(
        today, anchors, report_date=REPORT_DATE, discovered_date_by_video=discovered, limit=10
    )
    assert [entry.video_id for entry in ranked[("creator", "c1")]["7d"]] == ["new_video"]
    assert [entry.video_id for entry in ranked[("creator", "c1")]["30d"]] == ["new_video"]
    assert ranked[("creator", "c1")]["7d"][0].gain == 50_000


def test_old_video_missing_an_anchor_is_incomplete_not_new():
    """A video discovered long before the anchor window opened (e.g. this
    pipeline's own bootstrap: it hasn't been running 30 days yet, so no D-30
    snapshot exists for ANYTHING) must stay None (a real gap) -- never
    fabricate a value just because a video happens to be old."""
    discovered = {"old_video": date(2026, 1, 1)}  # long before any anchor date below
    today = [_history_row("old_video", 999_999)]
    anchors = {1: [], 7: [], 30: []}

    values = period_values(today, anchors, report_date=REPORT_DATE, discovered_date_by_video=discovered)
    assert values["old_video"] == {"1d": None, "7d": None, "30d": None, "all": 999_999}


def test_discovered_date_exactly_on_the_anchor_date_is_incomplete_not_new():
    """Boundary case: discovered_date == anchor_date means the video already
    existed (however briefly) on the anchor's own date, so a missing anchor
    there is a real gap -- only strictly *after* the anchor date counts as new."""
    anchor_date = REPORT_DATE - timedelta(days=7)
    discovered = {"v1": anchor_date}
    today = [_history_row("v1", 1_000)]

    gains = exact_gains(today, {1: [], 7: [], 30: []}, report_date=REPORT_DATE, discovered_date_by_video=discovered)
    assert gains["v1"][7] is None


def test_unknown_discovered_date_is_never_treated_as_new_even_during_pipeline_bootstrap():
    """A video absent from discovered_date_by_video entirely (the default,
    conservative case) must never be classified as new -- regression guard for
    UNKNOWN_DISCOVERED_DATE actually being date.min, not some date that could
    accidentally sit after an early anchor date during this pipeline's own
    first 30 days of operation (see UNKNOWN_DISCOVERED_DATE's own docstring)."""
    assert UNKNOWN_DISCOVERED_DATE == date.min
    today = [_history_row("v1", 500)]
    # An anchor date far in the past -- if the fallback were anything other
    # than date.min, a sufficiently early anchor_date could still be treated
    # as "before an unknown discovery date", wrongly implying new.
    early_report_date = date(2026, 8, 30)  # 30d anchor = 2026-07-31

    gains = exact_gains(today, {1: [], 7: [], 30: []}, report_date=early_report_date)
    assert gains["v1"] == {1: None, 7: None, 30: None}


def test_backward_compatible_manifest_without_discovered_at_is_never_treated_as_new():
    """An old ManifestEntry (written before discovered_at existed) must still
    deserialize/aggregate correctly, with its unknown discovery date never
    read as "new"."""
    old_entry = ManifestEntry(video_id="v1", creator_id="c1", active=True)  # no discovered_at at all
    dates = discovered_dates_by_video([old_entry])
    assert dates["v1"] == UNKNOWN_DISCOVERED_DATE

    today = [_history_row("v1", 500)]
    gains = exact_gains(today, {1: [], 7: [], 30: []}, report_date=REPORT_DATE, discovered_date_by_video=dates)
    assert gains["v1"] == {1: None, 7: None, 30: None}

