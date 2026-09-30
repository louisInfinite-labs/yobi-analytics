"""Focused tests for analytics.video_ranking_result (video-ranking Phase C
payload builder) -- the corrected, one-canonical-row-per-video shape."""

from __future__ import annotations

from datetime import date

from analytics.video_ranking import build_creator_video_catalog
from analytics.video_ranking_result import build_video_ranking_result
from stores.history_store import HistoryRow

REPORT_DATE = date(2026, 9, 29)


def _row(video_id: str, creator_id: str, view_count: int) -> HistoryRow:
    return HistoryRow(
        video_id=video_id,
        creator_id=creator_id,
        view_count=view_count,
        observed_at="2026-09-29T18:00:00+09:00",
        availability_status="available",
    )


def test_builds_the_full_payload_shape_for_a_creator_with_eligible_videos():
    today = [_row("a1", "creator_a", 200), _row("a2", "creator_a", 100)]
    anchors = {1: [_row("a1", "creator_a", 150)], 7: [], 30: []}
    catalog = build_creator_video_catalog(
        today,
        anchors,
        creator_id="creator_a",
        report_date=REPORT_DATE,
        topic_by_video={"a1": "valorant"},
        title_by_video={"a1": "A Title"},
        thumbnail_by_video={"a1": "https://i.ytimg.com/vi/a1/maxresdefault.jpg"},
        published_at_by_video={"a1": "2026-08-01T00:00:00Z"},
        discovered_at_by_video={"a1": "2026-08-01T00:00:00Z"},
    )

    result = build_video_ranking_result(
        report_date=REPORT_DATE, creator_id="creator_a", generated_at="2026-09-29T18:05:00+09:00", rows=catalog
    )

    assert result["reportDate"] == "2026-09-29"
    assert result["creatorId"] == "creator_a"
    assert result["generatedAt"] == "2026-09-29T18:05:00+09:00"
    assert {row["videoId"] for row in result["videos"]} == {"a1", "a2"}
    # Exactly one canonical row per video -- no per-metric duplication.
    assert len(result["videos"]) == 2

    a1 = next(row for row in result["videos"] if row["videoId"] == "a1")
    assert a1 == {
        "videoId": "a1",
        "creatorId": "creator_a",
        "topic": "valorant",
        "currentViewCount": 200,
        "title": "A Title",
        "thumbnailUrl": "https://i.ytimg.com/vi/a1/maxresdefault.jpg",
        "publishedAt": "2026-08-01T00:00:00Z",
        "discoveredAt": "2026-08-01T00:00:00Z",
        "anchor1dViewCount": 150,
        "anchor7dViewCount": None,
        "anchor30dViewCount": None,
    }

    a2 = next(row for row in result["videos"] if row["videoId"] == "a2")
    assert a2["title"] is None
    assert a2["thumbnailUrl"] is None
    assert a2["anchor1dViewCount"] is None


def test_returns_none_when_the_creator_has_no_eligible_videos_today():
    catalog = build_creator_video_catalog(
        [], {1: [], 7: [], 30: []}, creator_id="creator_a", report_date=REPORT_DATE, topic_by_video={}
    )

    result = build_video_ranking_result(
        report_date=REPORT_DATE, creator_id="creator_a", generated_at="2026-09-29T18:05:00+09:00", rows=catalog
    )

    assert result is None
