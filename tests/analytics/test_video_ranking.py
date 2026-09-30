"""Focused tests for analytics.video_ranking (video-ranking Phase B/Phase C
correction): per-creator canonical catalog building (build_creator_video_
catalog) and read-time metric/topic ranking (rank_video_rows).
"""

from __future__ import annotations

from datetime import date

from analytics.video_ranking import (
    GROWTH_METRICS,
    TOPIC_SCOPE_ALL,
    TOTAL_METRIC,
    VALID_METRICS,
    VALID_TOPIC_SCOPES,
    build_creator_video_catalog,
    rank_video_rows,
)
from analytics.video_ranking_result import build_video_ranking_result
from stores.history_store import HistoryRow

REPORT_DATE = date(2026, 9, 29)
D1 = date(2026, 9, 28)
D7 = date(2026, 9, 22)
D30 = date(2026, 8, 30)


def _row(video_id: str, creator_id: str, view_count: int) -> HistoryRow:
    return HistoryRow(
        video_id=video_id,
        creator_id=creator_id,
        view_count=view_count,
        observed_at="2026-09-29T18:00:00+09:00",
        availability_status="available",
    )


def _empty_anchors() -> dict[int, list[HistoryRow]]:
    return {1: [], 7: [], 30: []}


def _canonical_dicts(rows, *, creator_id="creator_a", topic_by_video=None, **kwargs):
    """Build the catalog then serialize it exactly the way the reducer's own
    persisted result would -- rank_video_rows only ever operates on this
    persisted dict shape, never the dataclass directly."""
    catalog = build_creator_video_catalog(
        rows,
        kwargs.pop("anchors", _empty_anchors()),
        creator_id=creator_id,
        report_date=REPORT_DATE,
        topic_by_video=topic_by_video or {},
        **kwargs,
    )
    result = build_video_ranking_result(
        report_date=REPORT_DATE, creator_id=creator_id, generated_at="2026-09-29T18:05:00+09:00", rows=catalog
    )
    return result["videos"] if result is not None else []


def test_module_exposes_the_expected_metric_and_topic_constants():
    assert VALID_METRICS == ("total", "1d", "7d", "30d")
    assert TOTAL_METRIC == "total"
    assert GROWTH_METRICS == ("1d", "7d", "30d")
    assert TOPIC_SCOPE_ALL == "all"
    assert VALID_TOPIC_SCOPES == frozenset(
        {"all", "valorant", "sf6", "apex", "minecraft", "singing", "chatting", "other"}
    )


def test_one_creator_never_includes_another_creators_videos():
    today = [
        _row("a1", "creator_a", 1_000),
        _row("a2", "creator_a", 500),
        _row("b1", "creator_b", 999_999),  # would dominate total ranking if leaked in
    ]
    catalog = build_creator_video_catalog(
        today, _empty_anchors(), creator_id="creator_a", report_date=REPORT_DATE, topic_by_video={}
    )

    video_ids = {row.video_id for row in catalog}
    assert video_ids == {"a1", "a2"}
    assert all(row.creator_id == "creator_a" for row in catalog)


def test_canonical_catalog_stores_exactly_one_row_per_video():
    """Phase C storage correction: the canonical catalog has exactly one row
    per video -- never a separate row per metric."""
    today = [_row("a1", "creator_a", 100), _row("a2", "creator_a", 200)]
    anchors = {1: [_row("a1", "creator_a", 90)], 7: [], 30: []}

    catalog = build_creator_video_catalog(
        today, anchors, creator_id="creator_a", report_date=REPORT_DATE, topic_by_video={}
    )

    assert len(catalog) == 2
    a1 = next(row for row in catalog if row.video_id == "a1")
    assert a1.anchor_view_counts == {"1d": 90, "7d": None, "30d": None}


def test_topic_all_includes_every_eligible_video_for_the_creator():
    today = [_row("a1", "creator_a", 100), _row("a2", "creator_a", 50), _row("a3", "creator_a", 10)]
    topic_by_video = {"a1": "valorant", "a2": "sf6", "a3": "other"}
    rows = _canonical_dicts(today, topic_by_video=topic_by_video)

    ranked = rank_video_rows(rows, metric="total", topic=TOPIC_SCOPE_ALL)

    assert {row["videoId"] for row in ranked} == {"a1", "a2", "a3"}
    assert {row["topic"] for row in ranked} == {"valorant", "sf6", "other"}


def test_specific_topic_filter_keeps_only_matching_videos_and_reranks():
    today = [_row("a1", "creator_a", 300), _row("a2", "creator_a", 200), _row("a3", "creator_a", 100)]
    topic_by_video = {"a1": "valorant", "a2": "sf6", "a3": "valorant"}
    rows = _canonical_dicts(today, topic_by_video=topic_by_video)

    valorant_only = rank_video_rows(rows, metric="total", topic="valorant")

    assert [row["videoId"] for row in valorant_only] == ["a1", "a3"]
    assert [row["rank"] for row in valorant_only] == [1, 2]  # re-numbered, not the original 1/3


def test_a_video_with_no_manifest_topic_falls_back_to_other():
    today = [_row("a1", "creator_a", 100)]
    rows = _canonical_dicts(today, topic_by_video={})

    ranked = rank_video_rows(rows, metric="total", topic=TOPIC_SCOPE_ALL)

    assert ranked[0]["topic"] == "other"


def test_an_unrecognized_persisted_topic_also_falls_back_to_other():
    today = [_row("a1", "creator_a", 100)]
    rows = _canonical_dicts(today, topic_by_video={"a1": "not-a-real-topic"})

    ranked = rank_video_rows(rows, metric="total", topic=TOPIC_SCOPE_ALL)

    assert ranked[0]["topic"] == "other"


def test_total_orders_by_current_view_count_descending():
    today = [_row("a1", "creator_a", 100), _row("a2", "creator_a", 300), _row("a3", "creator_a", 200)]
    rows = _canonical_dicts(today)

    ranked = rank_video_rows(rows, metric="total", topic=TOPIC_SCOPE_ALL)

    assert [row["videoId"] for row in ranked] == ["a2", "a3", "a1"]
    assert [row["rank"] for row in ranked] == [1, 2, 3]


def test_total_deterministic_tie_break_is_video_id_ascending():
    today = [_row("z", "creator_a", 100), _row("a", "creator_a", 100), _row("m", "creator_a", 100)]
    rows = _canonical_dicts(today)

    ranked = rank_video_rows(rows, metric="total", topic=TOPIC_SCOPE_ALL)

    assert [row["videoId"] for row in ranked] == ["a", "m", "z"]


def test_1d_growth_orders_by_absolute_growth_descending():
    today = [_row("a1", "creator_a", 150), _row("a2", "creator_a", 300)]
    anchors = _empty_anchors()
    anchors[1] = [_row("a1", "creator_a", 100), _row("a2", "creator_a", 250)]  # both gain 50
    rows = _canonical_dicts(today, anchors=anchors)

    ranked = rank_video_rows(rows, metric="1d", topic=TOPIC_SCOPE_ALL)

    assert [row["absoluteGrowth"] for row in ranked] == [50, 50]
    assert [row["videoId"] for row in ranked] == ["a1", "a2"]  # tie -> videoId ascending


def test_7d_growth_orders_by_absolute_growth_descending():
    today = [_row("a1", "creator_a", 500), _row("a2", "creator_a", 500)]
    anchors = _empty_anchors()
    anchors[7] = [_row("a1", "creator_a", 100), _row("a2", "creator_a", 400)]
    rows = _canonical_dicts(today, anchors=anchors)

    ranked = rank_video_rows(rows, metric="7d", topic=TOPIC_SCOPE_ALL)

    assert [row["videoId"] for row in ranked] == ["a1", "a2"]
    assert [row["absoluteGrowth"] for row in ranked] == [400, 100]


def test_30d_growth_orders_by_absolute_growth_descending():
    today = [_row("a1", "creator_a", 1_000), _row("a2", "creator_a", 1_000)]
    anchors = _empty_anchors()
    anchors[30] = [_row("a1", "creator_a", 900), _row("a2", "creator_a", 100)]
    rows = _canonical_dicts(today, anchors=anchors)

    ranked = rank_video_rows(rows, metric="30d", topic=TOPIC_SCOPE_ALL)

    assert [row["videoId"] for row in ranked] == ["a2", "a1"]
    assert [row["absoluteGrowth"] for row in ranked] == [900, 100]


def test_percentage_growth_never_controls_order():
    """a1 has a huge percentageGrowth (tiny anchor) but a smaller absoluteGrowth
    than a2 (huge anchor, huge current count) -- must still rank behind a2."""
    today = [_row("a1", "creator_a", 110), _row("a2", "creator_a", 1_001_000)]
    anchors = _empty_anchors()
    anchors[1] = [_row("a1", "creator_a", 10), _row("a2", "creator_a", 1_000_000)]
    rows = _canonical_dicts(today, anchors=anchors)

    ranked = rank_video_rows(rows, metric="1d", topic=TOPIC_SCOPE_ALL)

    assert [row["videoId"] for row in ranked] == ["a2", "a1"]
    assert ranked[0]["absoluteGrowth"] == 1_000
    assert ranked[1]["absoluteGrowth"] == 100
    # a1's percentage (1000%) is far larger than a2's (0.1%), yet a1 ranks last.
    assert ranked[1]["percentageGrowth"] > ranked[0]["percentageGrowth"]


def test_zero_anchor_view_count_makes_percentage_growth_null():
    today = [_row("a1", "creator_a", 50)]
    anchors = _empty_anchors()
    anchors[1] = [_row("a1", "creator_a", 0)]
    rows = _canonical_dicts(today, anchors=anchors)

    ranked = rank_video_rows(rows, metric="1d", topic=TOPIC_SCOPE_ALL)

    assert ranked[0]["anchorViewCount"] == 0
    assert ranked[0]["absoluteGrowth"] == 50
    assert ranked[0]["percentageGrowth"] is None


def test_genuine_missing_anchor_makes_the_video_unavailable_for_that_period():
    """No anchor row for a1 at D-7, and no discovered_date evidence -> a real
    collection gap, never a fabricated 0 baseline -- a1 must be excluded from
    the 7d ranking entirely, not given anchorViewCount=0."""
    today = [_row("a1", "creator_a", 500)]
    rows = _canonical_dicts(today)  # no D-7 row at all for a1

    assert rank_video_rows(rows, metric="7d", topic=TOPIC_SCOPE_ALL) == []
    assert rows[0]["anchor7dViewCount"] is None


def test_established_new_video_baseline_is_preserved_for_a_video_discovered_after_the_anchor_date():
    """A video discovered after D-7 (no anchor snapshot could possibly exist)
    is ranked with its full current count as the period's value -- the same
    analytics.history_ranking._period_value rule the pre-existing creator/org
    trending pipeline already relies on, reused here unchanged."""
    today = [_row("new_video", "creator_a", 777)]
    discovered_date_by_video = {"new_video": date(2026, 9, 27)}  # after D-7 (2026-09-22)
    rows = _canonical_dicts(today, discovered_date_by_video=discovered_date_by_video)

    ranked = rank_video_rows(rows, metric="7d", topic=TOPIC_SCOPE_ALL)

    assert len(ranked) == 1
    assert ranked[0]["videoId"] == "new_video"
    assert ranked[0]["anchorViewCount"] == 0
    assert ranked[0]["absoluteGrowth"] == 777


def test_a_video_discovered_before_the_anchor_date_with_no_anchor_row_is_a_real_gap_not_new():
    """Same missing-anchor shape as above, but discovered well before D-7 --
    this is a genuine collection gap, not a new video, so it must stay
    excluded (never a fabricated 0 baseline just because a discovered_date
    happens to be known)."""
    today = [_row("old_video", "creator_a", 777)]
    discovered_date_by_video = {"old_video": date(2026, 1, 1)}  # long before D-7
    rows = _canonical_dicts(today, discovered_date_by_video=discovered_date_by_video)

    assert rank_video_rows(rows, metric="7d", topic=TOPIC_SCOPE_ALL) == []


def test_metadata_propagation_carries_title_and_thumbnail_into_ranked_rows():
    """title/thumbnailUrl (video-ranking metadata propagation) flow straight
    from the canonical catalog into every ranked row, for both total and
    growth metrics -- no runtime DynamoDB enrichment involved anywhere here."""
    today = [_row("a1", "creator_a", 100)]
    catalog = build_creator_video_catalog(
        today,
        _empty_anchors(),
        creator_id="creator_a",
        report_date=REPORT_DATE,
        topic_by_video={},
        title_by_video={"a1": "A Great Video"},
        thumbnail_by_video={"a1": "https://i.ytimg.com/vi/a1/maxresdefault.jpg"},
    )
    result = build_video_ranking_result(
        report_date=REPORT_DATE, creator_id="creator_a", generated_at="2026-09-29T18:05:00+09:00", rows=catalog
    )

    ranked = rank_video_rows(result["videos"], metric="total", topic=TOPIC_SCOPE_ALL)

    assert ranked[0]["title"] == "A Great Video"
    assert ranked[0]["thumbnailUrl"] == "https://i.ytimg.com/vi/a1/maxresdefault.jpg"


def test_a_video_with_no_known_metadata_has_null_title_and_thumbnail():
    today = [_row("a1", "creator_a", 100)]
    rows = _canonical_dicts(today)

    ranked = rank_video_rows(rows, metric="total", topic=TOPIC_SCOPE_ALL)

    assert ranked[0]["title"] is None
    assert ranked[0]["thumbnailUrl"] is None
