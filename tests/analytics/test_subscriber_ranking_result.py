"""Tests for analytics.subscriber_ranking_result.build_subscriber_ranking_result
(ranking-simplification, R4) -- the JSON RESULT payload built from R2's pure
calculation plus R1/R3's daily subscriber-history rows.
"""

from __future__ import annotations

from datetime import date

from analytics.subscriber_ranking_result import build_subscriber_ranking_result
from stores.subscriber_history_store import SubscriberRow
from tracking.creator_master import Creator

REPORT_DATE = date(2026, 9, 29)
GENERATED_AT = "2026-09-29T18:05:00+09:00"
OBSERVED_AT = "2026-09-29T18:00:00+09:00"


def _creator(creator_id: str, organization: str = "hololive") -> Creator:
    return Creator(
        creator_id=creator_id,
        display_name=creator_id,
        organization=organization,
        youtube_channel_id=f"UC_{creator_id}",
        active=True,
        branch="holo_jp",
        group_key=["NO"],
        channel_type="member",
        lifecycle_stage="active",
        display_order=1,
    )


def _row(creator_id: str, subscriber_count: int | None, *, hidden: bool = False) -> SubscriberRow:
    return SubscriberRow(
        creator_id=creator_id, subscriber_count=subscriber_count, hidden_subscriber_count=hidden, observed_at=OBSERVED_AT
    )


def _build(current_rows, anchors=None, creators=None):
    return build_subscriber_ranking_result(
        report_date=REPORT_DATE,
        generated_at=GENERATED_AT,
        current_rows=current_rows,
        anchor_rows_by_days=anchors or {1: [], 7: [], 30: []},
        creators=creators if creators is not None else [_creator("a"), _creator("b", "vspo")],
    )


# --- 1/2/3. one result object, exactly four canonical rankings, no dup lists


def test_result_contains_exactly_four_canonical_ranking_collections():
    result = _build([_row("a", 100), _row("b", 200)])

    assert set(result) >= {"total", "1d", "7d", "30d"}
    for key in ("total", "1d", "7d", "30d"):
        assert "rows" in result[key]
        assert "ineligible" in result[key]
    # No ALL/VSPO/Hololive-specific keys anywhere in the payload.
    assert not any("vspo" in key.lower() or "hololive" in key.lower() or "all" == key.lower() for key in result)


def test_result_has_required_top_level_metadata_fields():
    result = _build([_row("a", 100), _row("b", 200)])

    assert result["reportDate"] == "2026-09-29"
    assert result["generatedAt"] == GENERATED_AT
    assert result["expectedCreatorCount"] == 2
    assert result["observedCreatorCount"] == 2
    assert result["missingCreatorCount"] == 0


# --- 4. organization retained on every eligible row --------------------------


def test_organization_present_on_every_eligible_row():
    result = _build([_row("a", 100), _row("b", 200)])

    for row in result["total"]["rows"]:
        assert row["organization"] in {"hololive", "vspo"}


# --- 5. Total sorting matches R2 ---------------------------------------------


def test_total_sorted_by_subscriber_count_descending():
    result = _build([_row("a", 100), _row("b", 300)])

    assert [row["creatorId"] for row in result["total"]["rows"]] == ["b", "a"]
    assert [row["rank"] for row in result["total"]["rows"]] == [1, 2]


# --- 6/7/8. 1d/7d/30d sorting matches R2 -------------------------------------


def test_growth_periods_sorted_by_absolute_growth_descending():
    current = [_row("a", 110), _row("b", 130)]
    anchors = {1: [_row("a", 100), _row("b", 100)], 7: [_row("a", 100), _row("b", 100)], 30: [_row("a", 100), _row("b", 100)]}

    result = _build(current, anchors)

    for period in ("1d", "7d", "30d"):
        assert [row["creatorId"] for row in result[period]["rows"]] == ["b", "a"]
        assert result[period]["rows"][0]["absoluteGrowth"] == 30


# --- 9. percentage does not affect ordering ----------------------------------


def test_percentage_growth_does_not_affect_ordering():
    current = [_row("a", 20), _row("b", 1_100)]
    anchors = {1: [_row("a", 10), _row("b", 1_000)], 7: [], 30: []}

    result = _build(current, anchors)

    assert [row["creatorId"] for row in result["1d"]["rows"]] == ["b", "a"]
    assert result["1d"]["rows"][1]["percentageGrowth"] == 1.0  # display-only, correctly preserved


# --- 10. exact anchors only --------------------------------------------------


def test_only_the_exact_anchor_rows_passed_in_are_consulted():
    current = [_row("a", 100)]
    # Anchor list omits "a" entirely -- must never substitute a nearby value.
    anchors = {1: [_row("someone_else", 999)], 7: [], 30: []}

    result = _build(current, anchors)

    assert result["1d"]["rows"] == []
    assert result["1d"]["ineligible"]["a"] == "anchor_missing"


# --- 11/12. missing/hidden diagnostics preserved -----------------------------


def test_missing_anchor_diagnostics_preserved():
    result = _build([_row("a", 100), _row("b", 200)], anchors={1: [_row("a", 90)], 7: [], 30: []})

    assert result["1d"]["ineligible"]["b"] == "anchor_missing"


def test_hidden_diagnostics_preserved():
    result = _build([_row("a", 100), _row("b", None, hidden=True)])

    assert result["total"]["ineligible"]["b"] == "current_hidden"
    assert [row["creatorId"] for row in result["total"]["rows"]] == ["a"]


# --- 13/14. partial D0 snapshot -> explicit incomplete metadata, no fabricated zero


def test_partial_d0_snapshot_produces_explicit_incomplete_metadata_no_fabricated_zero():
    creators = [_creator("a"), _creator("b"), _creator("c")]
    # "c" has no row at all in today's collection (a failed/still-repairing observation).
    result = _build([_row("a", 100), _row("b", 200)], creators=creators)

    assert result["expectedCreatorCount"] == 3
    assert result["observedCreatorCount"] == 2
    assert result["missingCreatorCount"] == 1
    assert result["total"]["ineligible"]["c"] == "current_missing"
    assert "c" not in {row["creatorId"] for row in result["total"]["rows"]}  # never a fabricated 0


# --- D0 with zero usable current observations: result is skipped (None) ----


def test_no_usable_current_observations_returns_none_not_an_empty_result():
    result = _build([], creators=[_creator("a"), _creator("b")])

    assert result is None


def test_all_current_rows_hidden_also_returns_none():
    result = _build([_row("a", None, hidden=True), _row("b", None, hidden=True)])

    assert result is None


# --- completeness counts when D0 contains a row for a creator no longer in
# --- the current authoritative roster (R3 preserves such rows, never prunes)


def test_row_for_a_creator_outside_the_roster_does_not_inflate_observed_count():
    """R3 intentionally preserves an existing D0 row for a creator later
    removed from the roster -- the raw snapshot can legitimately contain
    more rows than the current roster has creators. That extra row must
    never inflate observedCreatorCount, must never make missingCreatorCount
    negative, and must never enter any canonical ranking."""
    creators = [_creator("creator_a"), _creator("creator_b")]  # authoritative roster: 2 creators
    current_rows = [
        _row("creator_a", 100),
        _row("creator_b", 200),
        _row("creator_departed", 999),  # no longer in the roster, but still in D0
    ]

    result = _build(current_rows, creators=creators)

    assert result["expectedCreatorCount"] == 2
    assert result["observedCreatorCount"] == 2  # not 3
    assert result["missingCreatorCount"] == 0  # not -1
    assert "creator_departed" not in {row["creatorId"] for row in result["total"]["rows"]}
    assert result["total"]["ineligible"]["creator_departed"] == "creator_not_in_roster"


def test_row_for_a_creator_outside_the_roster_never_enters_any_growth_ranking():
    creators = [_creator("creator_a")]
    current = [_row("creator_a", 110), _row("creator_departed", 500)]
    anchors = {1: [_row("creator_a", 100), _row("creator_departed", 400)], 7: [], 30: []}

    result = _build(current, anchors, creators=creators)

    for period in ("1d", "7d", "30d"):
        assert "creator_departed" not in {row["creatorId"] for row in result[period]["rows"]}


def test_creator_with_a_real_observation_but_invalid_organization_still_counts_as_observed():
    """Organization validity is a ranking-eligibility concern (R2's own
    organization_missing/organization_invalid checks) -- NOT a collection-
    completeness concern. A roster creator with a real D0 row but an
    invalid/missing organization on their own Creator Master record still
    counts as observed here, even though R2 excludes them from ranking."""
    creators = [_creator("creator_a"), _creator("creator_bad_org", organization="not_a_real_org")]
    current_rows = [_row("creator_a", 100), _row("creator_bad_org", 200)]

    result = _build(current_rows, creators=creators)

    assert result["expectedCreatorCount"] == 2
    assert result["observedCreatorCount"] == 2  # both roster creators have a real row
    assert result["missingCreatorCount"] == 0
    assert result["total"]["ineligible"]["creator_bad_org"] == "organization_invalid"
    assert "creator_bad_org" not in {row["creatorId"] for row in result["total"]["rows"]}


def test_hidden_row_for_a_roster_creator_still_counts_as_observed_alongside_a_departed_row():
    creators = [_creator("creator_a"), _creator("creator_hidden")]
    current_rows = [
        _row("creator_a", 100),
        _row("creator_hidden", None, hidden=True),
        _row("creator_departed", 999),
    ]

    result = _build(current_rows, creators=creators)

    assert result["expectedCreatorCount"] == 2
    assert result["observedCreatorCount"] == 2  # hidden counts; departed does not
    assert result["missingCreatorCount"] == 0
