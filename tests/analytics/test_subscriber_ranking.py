"""Tests for analytics.subscriber_ranking (ranking-simplification, subscriber
leaderboard calculation, R2) -- exactly four canonical results (Total
Subscribers, 1d/7d/30d growth), never 12 organization-specific copies.
"""

from __future__ import annotations

import ast
import inspect

from analytics.subscriber_ranking import (
    CreatorSubscriberDimensions,
    build_growth_leaderboard,
    build_subscriber_leaderboards,
    build_total_subscribers_leaderboard,
    filter_by_organization,
)
from stores.subscriber_history_store import SubscriberRow

OBSERVED_AT = "2026-09-29T18:00:00+09:00"


def _row(creator_id: str, subscriber_count: int | None, *, hidden: bool = False) -> SubscriberRow:
    return SubscriberRow(
        creator_id=creator_id,
        subscriber_count=subscriber_count,
        hidden_subscriber_count=hidden,
        observed_at=OBSERVED_AT,
    )


def _dims(**organization_by_creator: str) -> dict[str, CreatorSubscriberDimensions]:
    return {creator_id: CreatorSubscriberDimensions(organization=org) for creator_id, org in organization_by_creator.items()}


# --- 1. Total Subscribers descending -----------------------------------------


def test_total_subscribers_sorted_descending():
    current = [_row("a", 100), _row("b", 300), _row("c", 200)]

    rows, ineligible = build_total_subscribers_leaderboard(current)

    assert [row.creator_id for row in rows] == ["b", "c", "a"]
    assert [row.rank for row in rows] == [1, 2, 3]
    assert ineligible == {}


# --- 2. Total tie -> creatorId deterministic tie-break -----------------------


def test_total_subscribers_tie_breaks_by_creator_id_ascending():
    current = [_row("zeta", 100), _row("alpha", 100), _row("mu", 100)]

    rows, _ = build_total_subscribers_leaderboard(current)

    assert [row.creator_id for row in rows] == ["alpha", "mu", "zeta"]


# --- 3/4/5. 1d/7d/30d absolute-growth descending -----------------------------


def test_growth_leaderboard_sorted_by_absolute_growth_descending():
    current = [_row("a", 110), _row("b", 130), _row("c", 105)]
    anchor = [_row("a", 100), _row("b", 100), _row("c", 100)]

    rows, ineligible = build_growth_leaderboard(current, anchor)

    assert [row.creator_id for row in rows] == ["b", "a", "c"]
    assert [row.absolute_growth for row in rows] == [30, 10, 5]
    assert ineligible == {}


def test_growth_leaderboard_works_identically_for_any_period_window():
    """build_growth_leaderboard itself is period-agnostic (period label is
    applied by build_subscriber_leaderboards) -- this proves the same
    sort/eligibility logic used for 1d also holds for 7d and 30d windows,
    i.e. there is no hidden 1d-specific behavior."""
    current = [_row("a", 500), _row("b", 700)]
    anchor_7d = [_row("a", 400), _row("b", 550)]
    anchor_30d = [_row("a", 100), _row("b", 800)]

    rows_7d, _ = build_growth_leaderboard(current, anchor_7d)
    rows_30d, _ = build_growth_leaderboard(current, anchor_30d)

    assert [row.creator_id for row in rows_7d] == ["b", "a"]
    assert [row.creator_id for row in rows_30d] == ["a", "b"]
    assert rows_30d[0].absolute_growth == 400
    assert rows_30d[1].absolute_growth == -100


# --- 6. Percentage does not affect order -------------------------------------


def test_percentage_growth_never_affects_sort_order():
    # "a" has a huge percentage gain but a small absolute gain; "b" is the
    # opposite. Ranking must follow absolute growth only.
    current = [_row("a", 20), _row("b", 1_100)]
    anchor = [_row("a", 10), _row("b", 1_000)]

    rows, _ = build_growth_leaderboard(current, anchor)

    assert [row.creator_id for row in rows] == ["b", "a"]
    assert rows[0].percentage_growth == 0.1
    assert rows[1].percentage_growth == 1.0


# --- 7. Missing current observation ------------------------------------------


def test_missing_current_observation_is_ineligible_for_total_and_growth():
    current = [_row("a", 100)]  # "b" simply absent -- no row at all
    anchor = [_row("a", 90), _row("b", 50)]

    total_rows, total_ineligible = build_total_subscribers_leaderboard(current)
    growth_rows, growth_ineligible = build_growth_leaderboard(current, anchor)

    assert [row.creator_id for row in total_rows] == ["a"]
    assert "b" not in total_ineligible  # never appeared in current_rows at all
    assert [row.creator_id for row in growth_rows] == ["a"]
    assert "b" not in growth_ineligible


# --- Roster-aware current_missing (R2 correction) ----------------------------


def test_roster_creator_absent_from_current_rows_is_reported_current_missing():
    """creator_b is known to the authoritative roster (dimensions_by_creator)
    but has no row at all in today's collection -- it must appear in every
    metric's diagnostics as current_missing, not silently disappear."""
    current = [_row("creator_a", 100), _row("creator_c", 300)]
    dims = _dims(creator_a="hololive", creator_b="hololive", creator_c="vspo")
    anchor = [_row("creator_a", 90), _row("creator_b", 80), _row("creator_c", 290)]

    total_rows, total_ineligible = build_total_subscribers_leaderboard(current, dimensions_by_creator=dims)
    growth_1d, growth_1d_ineligible = build_growth_leaderboard(current, anchor, dimensions_by_creator=dims)

    assert total_ineligible["creator_b"] == "current_missing"
    assert growth_1d_ineligible["creator_b"] == "current_missing"


def test_roster_creator_absent_from_current_rows_is_absent_from_all_four_ranked_lists():
    current = [_row("creator_a", 100), _row("creator_c", 300)]
    dims = _dims(creator_a="hololive", creator_b="hololive", creator_c="vspo")
    anchors = {
        1: [_row("creator_a", 90), _row("creator_b", 80), _row("creator_c", 290)],
        7: [_row("creator_a", 70), _row("creator_b", 60), _row("creator_c", 270)],
        30: [_row("creator_a", 10), _row("creator_b", 5), _row("creator_c", 100)],
    }

    result = build_subscriber_leaderboards(current, anchors, dimensions_by_creator=dims)

    assert "creator_b" not in {row.creator_id for row in result.total}
    for period in ("1d", "7d", "30d"):
        assert "creator_b" not in {row.creator_id for row in result.growth[period]}
        assert result.growth_ineligible[period]["creator_b"] == "current_missing"
    assert result.total_ineligible["creator_b"] == "current_missing"


def test_hidden_and_missing_remain_distinct_diagnostics_in_the_same_roster():
    """creator_hidden has a row but it's hidden; creator_missing has no row
    at all. Both must be excluded, but with different reason strings -- one
    must never be reported as the other."""
    current = [_row("creator_visible", 100), _row("creator_hidden", None, hidden=True)]
    dims = _dims(creator_visible="hololive", creator_hidden="hololive", creator_missing="vspo")

    total_rows, total_ineligible = build_total_subscribers_leaderboard(current, dimensions_by_creator=dims)

    assert total_ineligible["creator_hidden"] == "current_hidden"
    assert total_ineligible["creator_missing"] == "current_missing"
    assert [row.creator_id for row in total_rows] == ["creator_visible"]


def test_creator_absent_from_both_roster_and_current_rows_is_never_invented():
    """A creator_id that appears in neither dimensions_by_creator nor
    current_rows has no authoritative record that it should exist at all --
    it must not be invented into any diagnostics dict."""
    current = [_row("creator_a", 100)]
    dims = _dims(creator_a="hololive")  # "creator_ghost" is in nobody's records

    total_rows, total_ineligible = build_total_subscribers_leaderboard(current, dimensions_by_creator=dims)

    assert "creator_ghost" not in total_ineligible
    assert set(total_ineligible.keys()) == set()


def test_current_row_not_in_roster_is_excluded_as_creator_not_in_roster():
    """A current observation whose creatorId is not in the authoritative
    roster (dimensions_by_creator) must never silently enter the canonical
    leaderboard with organization=None -- it is excluded entirely and
    reported as creator_not_in_roster, distinct from current_missing/
    current_hidden."""
    current = [_row("creator_a", 100), _row("creator_unlisted", 200)]
    dims = _dims(creator_a="hololive")  # creator_unlisted intentionally omitted

    rows, ineligible = build_total_subscribers_leaderboard(current, dimensions_by_creator=dims)

    assert ineligible["creator_unlisted"] == "creator_not_in_roster"
    assert {row.creator_id for row in rows} == {"creator_a"}


def test_current_row_with_missing_organization_is_excluded():
    current = [_row("creator_a", 100)]
    dims = _dims(creator_a=None)

    rows, ineligible = build_total_subscribers_leaderboard(current, dimensions_by_creator=dims)

    assert ineligible["creator_a"] == "organization_missing"
    assert rows == []


def test_current_row_with_invalid_organization_is_excluded():
    current = [_row("creator_a", 100)]
    dims = _dims(creator_a="apex_predators")  # not vspo/hololive

    rows, ineligible = build_total_subscribers_leaderboard(current, dimensions_by_creator=dims)

    assert ineligible["creator_a"] == "organization_invalid"
    assert rows == []


def test_growth_leaderboard_also_excludes_not_in_roster_and_invalid_organization():
    current = [_row("creator_a", 100), _row("creator_unlisted", 200), _row("creator_bad_org", 300)]
    anchor = [_row("creator_a", 90), _row("creator_unlisted", 180), _row("creator_bad_org", 290)]
    dims = _dims(creator_a="hololive", creator_bad_org="not_a_real_org")

    rows, ineligible = build_growth_leaderboard(current, anchor, dimensions_by_creator=dims)

    assert {row.creator_id for row in rows} == {"creator_a"}
    assert ineligible["creator_unlisted"] == "creator_not_in_roster"
    assert ineligible["creator_bad_org"] == "organization_invalid"


def test_no_invalid_creator_appears_in_any_canonical_ranking():
    """A mix of valid, not-in-roster, missing-organization and invalid-
    organization creators: only the valid ones may appear in any of the
    four canonical results."""
    current = [
        _row("valid_holo", 100),
        _row("valid_vspo", 200),
        _row("no_org", 300),
        _row("bad_org", 400),
        _row("ghost", 500),  # not in dims at all
    ]
    dims = _dims(valid_holo="hololive", valid_vspo="vspo", no_org=None, bad_org="apex_predators")
    anchors = {
        1: [_row(cid, count - 10) for cid, count in [("valid_holo", 100), ("valid_vspo", 200), ("no_org", 300), ("bad_org", 400)]],
        7: [],
        30: [],
    }

    result = build_subscriber_leaderboards(current, anchors, dimensions_by_creator=dims)

    valid_ids = {"valid_holo", "valid_vspo"}
    all_ranked_ids = {row.creator_id for row in result.total}
    for period_rows in result.growth.values():
        all_ranked_ids |= {row.creator_id for row in period_rows}
    assert all_ranked_ids <= valid_ids
    assert all_ranked_ids == valid_ids  # both valid creators do appear somewhere
    assert result.total_ineligible["no_org"] == "organization_missing"
    assert result.total_ineligible["bad_org"] == "organization_invalid"
    assert result.total_ineligible["ghost"] == "creator_not_in_roster"


def test_all_equals_exactly_the_union_of_eligible_vspo_and_hololive_creators():
    current = [
        _row("holo_1", 500),
        _row("vspo_1", 400),
        _row("holo_2", 300),
        _row("invalid_org_creator", 999),
        _row("no_org_creator", 888),
    ]
    dims = _dims(holo_1="hololive", vspo_1="vspo", holo_2="hololive", invalid_org_creator="unknown", no_org_creator=None)

    canonical, _ = build_total_subscribers_leaderboard(current, dimensions_by_creator=dims)
    vspo_view = filter_by_organization(canonical, "vspo")
    holo_view = filter_by_organization(canonical, "hololive")

    all_ids = {row.creator_id for row in canonical}
    union_ids = {row.creator_id for row in vspo_view} | {row.creator_id for row in holo_view}
    assert all_ids == union_ids
    assert all_ids == {"holo_1", "vspo_1", "holo_2"}


# --- 8. Hidden current observation --------------------------------------------


def test_hidden_current_observation_is_ineligible_for_total_and_growth():
    current = [_row("a", 100), _row("b", None, hidden=True)]
    anchor = [_row("a", 90), _row("b", 50)]

    total_rows, total_ineligible = build_total_subscribers_leaderboard(current)
    growth_rows, growth_ineligible = build_growth_leaderboard(current, anchor)

    assert [row.creator_id for row in total_rows] == ["a"]
    assert total_ineligible["b"] == "current_hidden"
    assert [row.creator_id for row in growth_rows] == ["a"]
    assert growth_ineligible["b"] == "current_hidden"


# --- 9. Missing anchor --------------------------------------------------------


def test_missing_anchor_is_ineligible_never_zero_baseline():
    current = [_row("a", 100), _row("b", 500)]
    anchor = [_row("a", 90)]  # "b" has no D-N snapshot at all

    rows, ineligible = build_growth_leaderboard(current, anchor)

    assert [row.creator_id for row in rows] == ["a"]
    assert ineligible["b"] == "anchor_missing"


# --- 10. Hidden anchor ---------------------------------------------------------


def test_hidden_anchor_is_ineligible():
    current = [_row("a", 100), _row("b", 500)]
    anchor = [_row("a", 90), _row("b", None, hidden=True)]

    rows, ineligible = build_growth_leaderboard(current, anchor)

    assert [row.creator_id for row in rows] == ["a"]
    assert ineligible["b"] == "anchor_hidden"


# --- 11. Real zero anchor: absolute valid / percentage None -------------------


def test_real_zero_anchor_computes_absolute_but_not_percentage():
    current = [_row("a", 50)]
    anchor = [_row("a", 0)]

    rows, ineligible = build_growth_leaderboard(current, anchor)

    assert ineligible == {}
    assert rows[0].absolute_growth == 50
    assert rows[0].percentage_growth is None


# --- 12. Missing tracking history is NOT zero ---------------------------------


def test_creator_not_yet_tracked_at_anchor_time_is_ineligible_not_zero():
    """A creator with no D-30 snapshot because tracking started after that
    date must be excluded from 30d growth -- never treated as if it had 0
    subscribers on D-30."""
    current = [_row("new_creator", 1_000)]
    anchor_30d: list[SubscriberRow] = []  # tracking had not started 30 days ago

    rows, ineligible = build_growth_leaderboard(current, anchor_30d)

    assert rows == []
    assert ineligible["new_creator"] == "anchor_missing"


# --- 13. Exact anchor required, no nearest-date substitution ------------------


def test_only_the_exact_anchor_rows_passed_in_are_ever_consulted():
    """build_growth_leaderboard performs no date arithmetic or lookup of its
    own -- it is handed exactly one anchor snapshot and never searches for a
    nearby substitute. Passing an anchor list that simply omits a creator
    (as if their nearest real snapshot were a different day) must still
    yield anchor_missing, never a silently substituted value."""
    current = [_row("a", 100)]
    almost_anchor_but_creator_missing = [_row("someone_else", 999)]

    rows, ineligible = build_growth_leaderboard(current, almost_anchor_but_creator_missing)

    assert rows == []
    assert ineligible["a"] == "anchor_missing"


def test_load_exact_anchor_subscriber_rows_reads_exactly_d1_d7_d30():
    from datetime import date

    from analytics.subscriber_ranking import load_exact_anchor_subscriber_rows

    class _RecordingStore:
        def __init__(self):
            self.requested_dates: list[date] = []

        def read_daily_snapshot(self, collection_date: date) -> list[SubscriberRow]:
            self.requested_dates.append(collection_date)
            return []

    store = _RecordingStore()
    report_date = date(2026, 9, 29)

    result = load_exact_anchor_subscriber_rows(store, report_date=report_date)

    assert set(result.keys()) == {1, 7, 30}
    assert sorted(store.requested_dates) == sorted(
        [date(2026, 9, 28), date(2026, 9, 22), date(2026, 8, 30)]
    )


# --- 14. ALL canonical list filtering to VSPO preserves order ----------------


def test_filtering_canonical_total_list_to_vspo_preserves_relative_order():
    current = [_row("h1", 500), _row("v1", 400), _row("h2", 300), _row("v2", 200)]
    dims = _dims(h1="hololive", v1="vspo", h2="hololive", v2="vspo")

    canonical, _ = build_total_subscribers_leaderboard(current, dimensions_by_creator=dims)
    vspo_view = filter_by_organization(canonical, "vspo")

    assert [row.creator_id for row in vspo_view] == ["v1", "v2"]
    # Independently sorting just the VSPO subset must match the filtered view.
    independent = sorted(
        [row for row in canonical if row.organization == "vspo"], key=lambda row: row.rank
    )
    assert [row.creator_id for row in vspo_view] == [row.creator_id for row in independent]


# --- 15. ALL canonical list filtering to Hololive preserves order ------------


def test_filtering_canonical_growth_list_to_hololive_preserves_relative_order():
    current = [_row("h1", 150), _row("v1", 140), _row("h2", 130)]
    anchor = [_row("h1", 100), _row("v1", 100), _row("h2", 100)]
    dims = _dims(h1="hololive", v1="vspo", h2="hololive")

    canonical, _ = build_growth_leaderboard(current, anchor, dimensions_by_creator=dims)
    holo_view = filter_by_organization(canonical, "hololive")

    assert [row.creator_id for row in holo_view] == ["h1", "h2"]
    independent = sorted(
        [row for row in canonical if row.organization == "hololive"],
        key=lambda row: -row.absolute_growth,
    )
    assert [row.creator_id for row in holo_view] == [row.creator_id for row in independent]


# --- 16. Filtered ranks can be re-numbered correctly -------------------------


def test_filtered_view_ranks_are_renumbered_starting_at_one():
    current = [_row("h1", 500), _row("v1", 400), _row("h2", 300)]
    dims = _dims(h1="hololive", v1="vspo", h2="hololive")

    canonical, _ = build_total_subscribers_leaderboard(current, dimensions_by_creator=dims)
    holo_view = filter_by_organization(canonical, "hololive")

    assert [row.rank for row in holo_view] == [1, 2]
    # Canonical (unfiltered) ranks are untouched by the filter operation.
    assert [row.rank for row in canonical] == [1, 2, 3]


def test_build_subscriber_leaderboards_produces_exactly_four_canonical_results():
    current = [_row("a", 100), _row("b", 200)]
    anchors = {1: [_row("a", 90), _row("b", 190)], 7: [_row("a", 80)], 30: []}
    dims = _dims(a="hololive", b="vspo")

    result = build_subscriber_leaderboards(current, anchors, dimensions_by_creator=dims)

    assert set(result.growth.keys()) == {"1d", "7d", "30d"}
    assert [row.creator_id for row in result.total] == ["b", "a"]
    assert [row.creator_id for row in result.growth["1d"]] == ["a", "b"]
    assert [row.creator_id for row in result.growth["7d"]] == ["a"]
    assert result.growth["30d"] == []
    assert result.growth_ineligible["30d"] == {"a": "anchor_missing", "b": "anchor_missing"}


def _imported_module_names(module) -> set[str]:
    """Top-level module names this module imports (via `import x` or
    `from x import y`) -- checked by AST, not substring search, so this
    module's own explanatory prose/docstrings (which legitimately mention
    history_ranking/DynamoDB by name to explain what this module deliberately
    avoids) can't produce a false positive."""
    tree = ast.parse(inspect.getsource(module))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".")[0])
    return names


# --- 17. No cross-video or video-ranking behavior introduced -----------------


def test_module_has_no_coupling_to_video_ranking_code():
    import analytics.subscriber_ranking as module

    imports = _imported_module_names(module)
    assert "history_ranking" not in imports
    assert "history_store" not in imports


# --- 18. No DynamoDB table/GSI dependency introduced -------------------------


def test_module_has_no_dynamodb_or_persistence_dependency():
    import analytics.subscriber_ranking as module

    imports = _imported_module_names(module)
    assert "boto3" not in imports
    assert "dynamodb_store" not in imports
    assert "botocore" not in imports
