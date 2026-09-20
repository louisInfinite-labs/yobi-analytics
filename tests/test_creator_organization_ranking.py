"""Success-path tests for the per-creator/per-organization precomputed ranking core.

Scope (per the current round): normal-case aggregation/reduction only —
malicious/malformed input is deliberately out of scope here. The one
"abnormal-looking but actually routine" case explicitly in scope is a
newly-discovered video with no D-7/D-30 anchor yet — that happens every
real day, not just as an edge case, so it gets full coverage below
alongside the historical "real gap, not new" case it must be told apart
from (history_ranking._period_value).
"""

from datetime import date, timedelta

from history_ranking import (
    ALL_PERIOD,
    UNKNOWN_DISCOVERED_DATE,
    CreatorDimensions,
    CreatorPeriodPartial,
    RankedGrowth,
    creator_period_partials,
    exact_gains,
    merge_creator_period_partials,
    organization_creator_leaderboards,
    period_values,
    top_n_by_scope,
)
from history_store import HistoryRow
from tracking_manifest import ManifestEntry, discovered_dates_by_video

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


# --- organization_creator_leaderboards ---------------------------------------


def _dimensions(**overrides):
    fields = {"organization": None, "branch": None}
    fields.update(overrides)
    return CreatorDimensions(**fields)


def _partial(creator_id, *, view_sum, catalog_video_count, top_candidates):
    return CreatorPeriodPartial(
        creator_id=creator_id,
        period=ALL_PERIOD,
        view_sum=view_sum,
        catalog_video_count=catalog_video_count,
        eligible_video_count=catalog_video_count,
        top_candidates=top_candidates,
    )


def test_organization_creator_leaderboards_orders_members_by_total_views_and_by_top_video():
    """The two organization member rankings are genuinely different sort keys --
    a creator with many small videos can out-total a creator with one huge
    video, or vice versa, and each leaderboard must reflect its own metric."""
    creator_partials = {
        "steady_creator": {
            ALL_PERIOD: _partial(
                "steady_creator",
                view_sum=900,  # highest total (many small videos)
                catalog_video_count=9,
                top_candidates=[_ranked("steady_creator", "s_v1", value=100, rank=1)],
            )
        },
        "viral_creator": {
            ALL_PERIOD: _partial(
                "viral_creator",
                view_sum=800,  # lower total, but...
                catalog_video_count=1,
                top_candidates=[_ranked("viral_creator", "v_v1", value=800, rank=1)],  # ...the single highest video
            )
        },
        "other_org_creator": {
            ALL_PERIOD: _partial(
                "other_org_creator",
                view_sum=10_000,  # would win both leaderboards if it leaked into vspo's
                catalog_video_count=1,
                top_candidates=[_ranked("other_org_creator", "o_v1", value=10_000, rank=1)],
            )
        },
    }
    dimensions_by_creator = {
        "steady_creator": _dimensions(organization="vspo"),
        "viral_creator": _dimensions(organization="vspo"),
        "other_org_creator": _dimensions(organization="hololive"),
    }

    leaderboards = organization_creator_leaderboards(creator_partials, dimensions_by_creator=dimensions_by_creator)

    vspo_board = leaderboards["vspo"][ALL_PERIOD]
    assert [entry.creator_id for entry in vspo_board.by_total_views] == ["steady_creator", "viral_creator"]
    assert [entry.value for entry in vspo_board.by_total_views] == [900, 800]
    assert [entry.creator_id for entry in vspo_board.by_top_video] == ["viral_creator", "steady_creator"]
    assert [entry.value for entry in vspo_board.by_top_video] == [800, 100]
    assert vspo_board.by_top_video[0].video_id == "v_v1"
    # Coverage fields: both vspo members are fully complete (catalog == eligible).
    assert vspo_board.member_count == 2
    assert vspo_board.complete_member_count == 2
    assert vspo_board.is_complete is True
    assert vspo_board.catalog_video_count == 9 + 1
    assert vspo_board.eligible_video_count == 9 + 1
    assert vspo_board.by_total_views[0].catalog_video_count == 9
    assert vspo_board.by_total_views[0].is_complete is True

    hololive_board = leaderboards["hololive"][ALL_PERIOD]
    assert [entry.creator_id for entry in hololive_board.by_total_views] == ["other_org_creator"]

    # hololive's creator must never appear in vspo's leaderboard, or vice versa.
    assert "other_org_creator" not in [e.creator_id for e in vspo_board.by_total_views]


def test_organization_creator_leaderboards_is_incomplete_when_any_member_is_incomplete():
    """Roadmap 5.x bootstrap-availability rule: the whole organization/period
    must be marked incomplete the moment even one member creator is (a real
    per-video gap, not a legitimately new video) -- never averaged away or
    silently rounded up to "mostly complete"."""
    creator_partials = {
        "complete_creator": {
            "7d": _partial("complete_creator", view_sum=500, catalog_video_count=5, top_candidates=[])
        },
        "incomplete_creator": {
            "7d": CreatorPeriodPartial(
                creator_id="incomplete_creator", period="7d", view_sum=300,
                catalog_video_count=5, eligible_video_count=3,  # 2 videos with a real gap
                top_candidates=[],
            )
        },
    }
    dimensions_by_creator = {
        "complete_creator": _dimensions(organization="vspo"),
        "incomplete_creator": _dimensions(organization="vspo"),
    }

    leaderboards = organization_creator_leaderboards(creator_partials, dimensions_by_creator=dimensions_by_creator)

    board = leaderboards["vspo"]["7d"]
    assert board.member_count == 2
    assert board.complete_member_count == 1
    assert board.is_complete is False
    assert board.catalog_video_count == 10
    assert board.eligible_video_count == 8


def test_organization_creator_leaderboards_excludes_a_creator_with_no_organization():
    creator_partials = {
        "no_org_creator": {
            ALL_PERIOD: _partial("no_org_creator", view_sum=999, catalog_video_count=1, top_candidates=[])
        }
    }
    dimensions_by_creator = {"no_org_creator": _dimensions(organization=None)}

    leaderboards = organization_creator_leaderboards(creator_partials, dimensions_by_creator=dimensions_by_creator)

    assert leaderboards == {}


# --- bootstrap availability lock-in (Roadmap 5.x: all=Day1, 1d=Day2, 7d=Day8, 30d=Day31) --


def _org_board_for(creator_id, period, agg, *, organization="vspo"):
    """One creator's org leaderboard for one period, isolated to just that pair."""
    return organization_creator_leaderboards(
        {creator_id: {period: agg}}, dimensions_by_creator={creator_id: _dimensions(organization=organization)}
    )[organization][period]


def test_all_period_is_complete_from_the_very_first_day_regardless_of_anchor_state():
    """"all" needs no historical anchor at all -- an organization's "all"
    leaderboard must be complete on literal Day 1 of collection, before any
    D-1/D-7/D-30 snapshot could possibly exist anywhere."""
    today = [_history_row("v1", 500, creator_id="c1")]
    # No anchors at all (as if this were the very first day of collection ever)
    # and no discovered_date info either -- the worst case for 1d/7d/30d, but
    # irrelevant to "all".
    partials = creator_period_partials(today, {1: [], 7: [], 30: []}, report_date=REPORT_DATE)

    board = _org_board_for("c1", ALL_PERIOD, partials["c1"][ALL_PERIOD])

    assert board.is_complete is True
    assert partials["c1"][ALL_PERIOD].is_complete is True


def test_growth_periods_stay_incomplete_for_a_pre_existing_video_until_their_own_anchor_exists():
    """A video that already existed before this pipeline's own history started
    (a real discovered_at from long ago, not "new") must keep 1d/7d/30d
    incomplete for as long as that period's own anchor is genuinely missing
    (bootstrap Day 1 through Day 7 for 7d, Day 1 through Day 30 for 30d) --
    and flip to complete the moment a real anchor snapshot exists (Day 8 for
    7d, Day 31 for 30d), never a day earlier and never fabricated in between."""
    discovered = {"old_video": date(2020, 1, 1)}  # far older than any anchor date below
    today = [_history_row("old_video", 10_000, creator_id="c1")]

    # Bootstrap: no D-1/D-7/D-30 snapshot exists anywhere yet (as if this ran
    # on collection Day 1-7 for the 7d case, Day 1-30 for the 30d case).
    bootstrap_partials = creator_period_partials(
        today, {1: [], 7: [], 30: []}, report_date=REPORT_DATE, discovered_date_by_video=discovered
    )
    for period in ("1d", "7d", "30d"):
        board = _org_board_for("c1", period, bootstrap_partials["c1"][period])
        assert board.is_complete is False, f"{period} must stay incomplete while its own anchor is missing"

    # Post-bootstrap: the real anchor now exists (Day 2 for 1d, Day 8 for 7d,
    # Day 31 for 30d) -- the exact same video must now read as complete.
    anchors_available = {
        1: [_history_row("old_video", 9_000, creator_id="c1")],
        7: [_history_row("old_video", 8_000, creator_id="c1")],
        30: [_history_row("old_video", 5_000, creator_id="c1")],
    }
    post_bootstrap_partials = creator_period_partials(
        today, anchors_available, report_date=REPORT_DATE, discovered_date_by_video=discovered
    )
    for period in ("1d", "7d", "30d"):
        board = _org_board_for("c1", period, post_bootstrap_partials["c1"][period])
        assert board.is_complete is True, f"{period} must become complete once its own real anchor exists"


def test_a_new_video_within_the_bootstrap_window_does_not_mask_an_old_videos_real_gap():
    """A genuinely new video (correctly baselined at 0, correctly "eligible")
    sitting in the same organization as an old video with a real missing
    anchor must not make the organization/period look complete -- one real
    gap is enough to keep the whole org/period incomplete, per
    organization_creator_leaderboards' own "any incomplete member" rule."""
    discovered = {
        "new_video": REPORT_DATE,  # discovered today -- legitimately new
        "old_video": date(2020, 1, 1),  # pre-existing, real gap
    }
    rows_new_creator = [_history_row("new_video", 500, creator_id="new_creator")]
    rows_old_creator = [_history_row("old_video", 900, creator_id="old_creator")]
    anchors = {1: [], 7: [], 30: []}

    new_creator_partials = creator_period_partials(
        rows_new_creator, anchors, report_date=REPORT_DATE, discovered_date_by_video=discovered
    )
    old_creator_partials = creator_period_partials(
        rows_old_creator, anchors, report_date=REPORT_DATE, discovered_date_by_video=discovered
    )
    assert new_creator_partials["new_creator"]["7d"].is_complete is True
    assert old_creator_partials["old_creator"]["7d"].is_complete is False

    combined = {**new_creator_partials, **old_creator_partials}
    dimensions_by_creator = {
        "new_creator": _dimensions(organization="vspo"),
        "old_creator": _dimensions(organization="vspo"),
    }
    board = organization_creator_leaderboards(combined, dimensions_by_creator=dimensions_by_creator)["vspo"]["7d"]

    assert board.member_count == 2
    assert board.complete_member_count == 1  # only new_creator
    assert board.is_complete is False


# --- organization count invariants (locked in after a prior report cited an
# inconsistent hand-written example -- 9+5=14, not 10; production aggregation
# was already correct, this pins it down with an explicit, varied fixture) --


def test_organization_count_invariants_hold_over_several_members_with_mixed_coverage():
    """org.catalogVideoCount/eligibleVideoCount must be the exact sum over
    every member; completeMemberCount must be the count of members whose own
    isComplete is true; org.isComplete must be exactly
    completeMemberCount == memberCount -- checked over 4 members with
    deliberately different catalog/eligible combinations, not just one."""
    members = {
        "m1": (12, 12),  # complete
        "m2": (7, 7),  # complete
        "m3": (9, 4),  # incomplete
        "m4": (3, 0),  # incomplete (nothing eligible at all)
    }
    creator_partials = {
        creator_id: {
            "7d": CreatorPeriodPartial(
                creator_id=creator_id, period="7d", view_sum=100,
                catalog_video_count=catalog, eligible_video_count=eligible, top_candidates=[],
            )
        }
        for creator_id, (catalog, eligible) in members.items()
    }
    dimensions_by_creator = {creator_id: _dimensions(organization="vspo") for creator_id in members}

    board = organization_creator_leaderboards(creator_partials, dimensions_by_creator=dimensions_by_creator)["vspo"]["7d"]

    expected_catalog_sum = sum(catalog for catalog, _ in members.values())
    expected_eligible_sum = sum(eligible for _, eligible in members.values())
    expected_complete_count = sum(1 for catalog, eligible in members.values() if catalog == eligible)

    assert expected_catalog_sum == 12 + 7 + 9 + 3 == 31
    assert expected_eligible_sum == 12 + 7 + 4 + 0 == 23
    assert board.catalog_video_count == expected_catalog_sum
    assert board.eligible_video_count == expected_eligible_sum
    assert board.member_count == len(members)
    assert board.complete_member_count == expected_complete_count == 2
    assert board.is_complete == (board.complete_member_count == board.member_count) == False

    # Every per-member leaderboard entry's own coverage fields must match
    # that same member's CreatorPeriodPartial exactly (no cross-member mixing).
    for entry in board.by_total_views:
        catalog, eligible = members[entry.creator_id]
        assert entry.catalog_video_count == catalog
        assert entry.eligible_video_count == eligible
        assert entry.is_complete == (catalog == eligible)


def test_organization_becomes_complete_only_once_every_member_is_complete():
    """Flipping the single incomplete member to complete must be exactly what
    changes org.isComplete from False to True -- not any averaging or
    threshold, one lagging member is always enough to keep it False."""
    def _board(second_member_eligible):
        creator_partials = {
            "m1": {"7d": CreatorPeriodPartial(creator_id="m1", period="7d", view_sum=0, catalog_video_count=5, eligible_video_count=5, top_candidates=[])},
            "m2": {"7d": CreatorPeriodPartial(creator_id="m2", period="7d", view_sum=0, catalog_video_count=5, eligible_video_count=second_member_eligible, top_candidates=[])},
        }
        dimensions_by_creator = {"m1": _dimensions(organization="vspo"), "m2": _dimensions(organization="vspo")}
        return organization_creator_leaderboards(creator_partials, dimensions_by_creator=dimensions_by_creator)["vspo"]["7d"]

    assert _board(second_member_eligible=4).is_complete is False
    assert _board(second_member_eligible=5).is_complete is True


def _ranked(creator_id, video_id, *, value, rank):
    return RankedGrowth(
        rank=rank,
        video_id=video_id,
        creator_id=creator_id,
        period=ALL_PERIOD,
        view_count=value,
        anchor_view_count=0,
        gain=value,
        observed_at="2026-09-09T18:00:00+09:00",
    )
