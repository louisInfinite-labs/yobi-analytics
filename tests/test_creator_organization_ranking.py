"""Success-path tests for the per-creator precomputed ranking core
(creator_period_partials, feeding creatorSummary) and the shared exact-
anchor/new-video-baseline rule it shares with top_n_by_scope's own video
ranking.

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
removed along with the zero-consumer endpoints/producers they covered.
"""

from datetime import date, timedelta

from analytics.history_ranking import (
    ALL_PERIOD,
    UNKNOWN_DISCOVERED_DATE,
    creator_period_partials,
    exact_gains,
    merge_creator_period_partials,
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


def test_aggregate_ranking_and_video_top_n_agree_on_the_same_new_videos_period_value():
    """creator_period_partials (this round's new aggregation) and top_n_by_scope
    (the existing video-ranking layer) must never disagree about what a given
    video's period value is -- both now share exact_gains/_period_value."""
    discovered = {"new_video": date(2026, 9, 8)}  # 1 day before REPORT_DATE
    today = [_history_row("new_video", 12_345, creator_id="c1")]
    anchors = {1: [], 7: [], 30: []}

    creator_partials = creator_period_partials(
        today, anchors, report_date=REPORT_DATE, discovered_date_by_video=discovered
    )
    video_ranking = top_n_by_scope(today, anchors, report_date=REPORT_DATE, discovered_date_by_video=discovered)

    assert creator_partials["c1"]["7d"].top_candidates[0].gain == 12_345
    assert video_ranking[("creator", "c1")]["7d"][0].gain == 12_345
    assert creator_partials["c1"]["7d"].top_candidates[0].gain == video_ranking[("creator", "c1")]["7d"][0].gain


# --- creator_period_partials: within one shard -------------------------------


def test_creator_period_partials_keeps_different_creators_independent_within_one_shard():
    """A single shard's rows can legitimately mix Hololive, VSPO, and any other
    creator together (sharding is by video_id, not by creator/org) -- each
    creator's own sum/count/top candidates must never see another creator's
    videos."""
    today = [
        _history_row("holo_v1", 1_000, creator_id="holo_creator"),
        _history_row("holo_v2", 2_000, creator_id="holo_creator"),
        _history_row("vspo_v1", 5_000, creator_id="vspo_creator"),
        _history_row("other_v1", 300, creator_id="other_creator"),
    ]
    anchors = {1: [], 7: [], 30: []}

    partials = creator_period_partials(today, anchors, report_date=REPORT_DATE)

    assert partials["holo_creator"][ALL_PERIOD].view_sum == 3_000
    assert partials["holo_creator"][ALL_PERIOD].eligible_video_count == 2
    assert partials["holo_creator"][ALL_PERIOD].is_complete
    assert [c.video_id for c in partials["holo_creator"][ALL_PERIOD].top_candidates] == ["holo_v2", "holo_v1"]

    assert partials["vspo_creator"][ALL_PERIOD].view_sum == 5_000
    assert partials["vspo_creator"][ALL_PERIOD].eligible_video_count == 1

    assert partials["other_creator"][ALL_PERIOD].view_sum == 300
    assert partials["other_creator"][ALL_PERIOD].eligible_video_count == 1

    # No cross-contamination: every creator's own top_candidates lists only its own videos.
    for creator_id, periods in partials.items():
        for agg in periods.values():
            assert all(entry.creator_id == creator_id for entry in agg.top_candidates)


def test_creator_period_partials_catalog_vs_eligible_count_reflects_a_real_gap():
    """Mixing one video with a real anchor, one new video (no anchor, but
    correctly baselined at 0), and one old video with a genuine gap (no
    anchor, pre-existing) in the same creator/shard: catalogVideoCount must
    count all three, eligibleVideoCount only the two with a real value."""
    discovered = {
        "has_anchor": date(2026, 1, 1),
        "new_video": date(2026, 9, 8),  # 1 day before REPORT_DATE -- new
        "gap_video": date(2026, 1, 1),  # old, but its 7d anchor is missing
    }
    today = [
        _history_row("has_anchor", 1_000, creator_id="c1"),
        _history_row("new_video", 500, creator_id="c1"),
        _history_row("gap_video", 2_000, creator_id="c1"),
    ]
    anchors = {1: [], 7: [_history_row("has_anchor", 800)], 30: []}

    partials = creator_period_partials(today, anchors, report_date=REPORT_DATE, discovered_date_by_video=discovered)

    agg = partials["c1"]["7d"]
    assert agg.catalog_video_count == 3
    assert agg.eligible_video_count == 2  # has_anchor (200 gain) + new_video (500 baseline-0) -- not gap_video
    assert agg.view_sum == 200 + 500
    assert not agg.is_complete


def test_creator_period_partials_sum_and_count_are_never_truncated_even_past_2000_videos():
    """Roadmap 5.x: the API's own MAX_LIVE_FALLBACK_VIDEOS guard (read_api.py) bounds
    an unrelated on-demand computation and must never leak into this scheduled
    background aggregation -- a creator with more than 2,000 videos in a single
    shard still gets every one of them counted in view_sum/eligible_video_count."""
    video_count = 2_500
    today = [_history_row(f"v{i}", i + 1, creator_id="big_creator") for i in range(video_count)]
    anchors = {1: [], 7: [], 30: []}

    partials = creator_period_partials(today, anchors, report_date=REPORT_DATE, limit=10)

    agg = partials["big_creator"][ALL_PERIOD]
    assert agg.catalog_video_count == video_count
    assert agg.eligible_video_count == video_count
    assert agg.view_sum == sum(i + 1 for i in range(video_count))
    assert len(agg.top_candidates) == 10  # only the candidate list is bounded


# --- cross-shard merge: sums/counts add up, Top-N survives correctly -------


def test_merge_creator_period_partials_sums_the_same_creators_videos_scattered_across_shards():
    """A creator's videos are scattered across every shard by video-id hash, not
    confined to one -- two shards' own partials for the same creator must merge
    into one exact total, not just the last shard seen."""
    shard_a = creator_period_partials(
        [_history_row("v1", 100, "c1"), _history_row("v2", 200, "c1")], {1: [], 7: [], 30: []}, report_date=REPORT_DATE
    )
    shard_b = creator_period_partials(
        [_history_row("v3", 300, "c1"), _history_row("v4", 400, "c1")], {1: [], 7: [], 30: []}, report_date=REPORT_DATE
    )

    merged = merge_creator_period_partials([shard_a, shard_b])

    agg = merged["c1"][ALL_PERIOD]
    assert agg.view_sum == 100 + 200 + 300 + 400
    assert agg.eligible_video_count == 4
    assert agg.catalog_video_count == 4
    assert [c.video_id for c in agg.top_candidates] == ["v4", "v3", "v2", "v1"]


def test_merge_creator_period_partials_top_n_equals_the_true_full_catalog_top_n():
    """Each shard only ever keeps its own bounded Top-N candidates -- merging
    those bounded lists back together must still land on exactly the same
    Top-N a single unbounded pass over the whole (unsharded) catalog would
    have produced, not an approximation. Also proves the cross-shard tie-break:
    every value here is distinct, but the same (-value, video_id) key used for
    ties is what keeps this deterministic regardless of shard read order."""
    limit = 3
    all_rows = [_history_row(f"v{i}", i, "c1") for i in range(20)]  # v19 (value 19) is the true best
    shard_a, shard_b = all_rows[:9], all_rows[9:]

    partial_a = creator_period_partials(shard_a, {1: [], 7: [], 30: []}, report_date=REPORT_DATE, limit=limit)
    partial_b = creator_period_partials(shard_b, {1: [], 7: [], 30: []}, report_date=REPORT_DATE, limit=limit)
    merged = merge_creator_period_partials([partial_a, partial_b], limit=limit)

    expected_top = sorted(all_rows, key=lambda row: (-row.view_count, row.video_id))[:limit]
    assert [c.video_id for c in merged["c1"][ALL_PERIOD].top_candidates] == [row.video_id for row in expected_top]
    assert [c.rank for c in merged["c1"][ALL_PERIOD].top_candidates] == [1, 2, 3]


def test_merge_creator_period_partials_breaks_cross_shard_ties_by_video_id():
    """Two videos tied on the exact same value, arriving from different shards
    (in either shard order) -- the merge must always land on the same winner,
    picked by video_id, never by which shard happened to be read/merged first."""
    tied_value = 999
    row_a = _history_row("aaa_ties_first", tied_value, "c1")
    row_b = _history_row("zzz_ties_last", tied_value, "c1")
    partial_from_a = creator_period_partials([row_a], {1: [], 7: [], 30: []}, report_date=REPORT_DATE, limit=1)
    partial_from_b = creator_period_partials([row_b], {1: [], 7: [], 30: []}, report_date=REPORT_DATE, limit=1)

    merged_a_then_b = merge_creator_period_partials([partial_from_a, partial_from_b], limit=1)
    merged_b_then_a = merge_creator_period_partials([partial_from_b, partial_from_a], limit=1)

    assert merged_a_then_b["c1"][ALL_PERIOD].top_candidates[0].video_id == "aaa_ties_first"
    assert merged_b_then_a["c1"][ALL_PERIOD].top_candidates[0].video_id == "aaa_ties_first"
