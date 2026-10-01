"""Tests for api.read_api.get_video_ranking (video-ranking Phase D) -- the
read-only API over the per-creator S3 video-ranking result. Phase C storage
correction: the persisted result now holds one canonical row per video
(a "videos" list); ranking/topic-filtering happen here, at read time, via
analytics.video_ranking.rank_video_rows.
"""

from __future__ import annotations

from datetime import date

import pytest

from api import read_api
from tracking.creator_master import Creator


def _creator(**overrides) -> Creator:
    fields = {
        "creator_id": "aizawa_ema",
        "display_name": "藍沢エマ",
        "organization": "vspo",
        "youtube_channel_id": "UC_test",
        "active": True,
        "branch": "vspo_jp",
        "group_key": ["1期生"],
        "channel_type": "member",
        "lifecycle_stage": "active",
        "display_order": 0,
    }
    fields.update(overrides)
    return Creator(**fields)


def _canonical_row(
    video_id: str,
    topic: str,
    current_view_count: int,
    *,
    creator_id: str = "aizawa_ema",
    content_type: str | None = None,
    live_status: str | None = None,
    anchor_1d: int | None = None,
    anchor_7d: int | None = None,
    anchor_30d: int | None = None,
    title: str | None = None,
    thumbnail_url: str | None = None,
    published_at: str | None = None,
) -> dict:
    return {
        "videoId": video_id,
        "creatorId": creator_id,
        "topic": topic,
        "contentType": content_type,
        "liveStatus": live_status,
        "currentViewCount": current_view_count,
        "anchor1dViewCount": anchor_1d,
        "anchor7dViewCount": anchor_7d,
        "anchor30dViewCount": anchor_30d,
        "title": title,
        "thumbnailUrl": thumbnail_url,
        "publishedAt": published_at,
        "discoveredAt": None,
    }


def _payload(**overrides) -> dict:
    payload = {
        "schemaVersion": 2,
        "reportDate": "2026-09-29",
        "creatorId": "aizawa_ema",
        "generatedAt": "2026-09-29T18:05:00+09:00",
        "videos": [
            _canonical_row("v1", "valorant", 500, anchor_1d=490, anchor_7d=430, anchor_30d=200),
            _canonical_row("v2", "sf6", 300, anchor_1d=270),
        ],
    }
    payload.update(overrides)
    return payload


class _FakeVideoRankingStore:
    def __init__(self, payload_by_date_creator: dict[tuple[str, str], dict | None]):
        self._payload = payload_by_date_creator

    def read_result(self, report_date: date, creator_id: str):
        return self._payload.get((report_date.isoformat(), creator_id))


def _wire_store(monkeypatch, payload_by_date_creator: dict[tuple[str, str], dict | None]):
    fake_store = _FakeVideoRankingStore(payload_by_date_creator)

    class _FakeStoreClass:
        @classmethod
        def from_environment(cls, *, s3_client=None):
            return fake_store

    monkeypatch.setattr(read_api, "S3VideoRankingStore", _FakeStoreClass)


DEFAULT_CREATORS = [_creator(creator_id="aizawa_ema"), _creator(creator_id="other_creator")]


def _query(**overrides) -> dict:
    query = {"creatorId": "aizawa_ema", "metric": "total", "reportDate": "2026-09-29"}
    query.update(overrides)
    return query


def _wire(monkeypatch, payload_by_date_creator):
    _wire_store(monkeypatch, payload_by_date_creator)
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)


# --- 1. valid requests -------------------------------------------------------


def test_valid_total_request_returns_rows_ranked_at_read_time(monkeypatch):
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): _payload()})

    result = read_api.get_video_ranking(_query())

    assert result["creatorId"] == "aizawa_ema"
    assert result["metric"] == "total"
    assert result["topic"] == "all"
    # v1 (500) outranks v2 (300) by currentViewCount -- computed here, not stored.
    assert [row["videoId"] for row in result["rows"]] == ["v1", "v2"]
    assert result["rows"][0]["rank"] == 1


@pytest.mark.parametrize("metric", ["1d", "7d", "30d"])
def test_valid_growth_metric_requests_are_ranked_at_read_time(monkeypatch, metric):
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): _payload()})

    result = read_api.get_video_ranking(_query(metric=metric))

    assert result["metric"] == metric
    for row in result["rows"]:
        assert "anchorViewCount" in row
        assert "absoluteGrowth" in row


def test_topic_filter_keeps_only_matching_rows_and_reranks(monkeypatch):
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): _payload()})

    result = read_api.get_video_ranking(_query(metric="total", topic="valorant"))

    assert [row["videoId"] for row in result["rows"]] == ["v1"]
    assert result["rows"][0]["rank"] == 1


def test_content_type_filter_keeps_only_matching_rows_and_reranks(monkeypatch):
    """contentType=live keeps only the archived-livestream row, independent
    of topic filtering."""
    payload = _payload(
        videos=[
            _canonical_row("v1", "valorant", 500, content_type="live"),
            _canonical_row("v2", "sf6", 300, content_type="upload"),
        ]
    )
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): payload})

    result = read_api.get_video_ranking(_query(metric="total", contentType="live"))

    assert result["contentType"] == "live"
    assert [row["videoId"] for row in result["rows"]] == ["v1"]
    assert result["rows"][0]["rank"] == 1


def test_content_type_and_topic_filters_combine_independently(monkeypatch):
    """topic and contentType are separate dimensions -- a video can match one
    without the other, and the response only keeps rows matching both."""
    payload = _payload(
        videos=[
            _canonical_row("v1", "valorant", 500, content_type="live"),
            _canonical_row("v2", "valorant", 400, content_type="upload"),
            _canonical_row("v3", "sf6", 300, content_type="live"),
        ]
    )
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): payload})

    result = read_api.get_video_ranking(_query(metric="total", topic="valorant", contentType="live"))

    assert [row["videoId"] for row in result["rows"]] == ["v1"]


def test_content_type_defaults_to_all_when_omitted(monkeypatch):
    payload = _payload(
        videos=[
            _canonical_row("v1", "valorant", 500, content_type="live"),
            _canonical_row("v2", "sf6", 300, content_type=None),
        ]
    )
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): payload})

    result = read_api.get_video_ranking(_query(metric="total"))

    assert result["contentType"] == "all"
    assert [row["videoId"] for row in result["rows"]] == ["v1", "v2"]


def test_content_type_filter_excludes_a_row_with_no_persisted_content_type(monkeypatch):
    """A row written before contentType existed (no key at all, unlike the
    None used above) never matches a specific contentType filter -- excluded,
    never fabricated as "upload"."""
    payload = _payload(
        videos=[
            {
                "videoId": "v1",
                "creatorId": "aizawa_ema",
                "topic": "valorant",
                "currentViewCount": 500,
                "anchor1dViewCount": None,
                "anchor7dViewCount": None,
                "anchor30dViewCount": None,
                "title": None,
                "thumbnailUrl": None,
                "publishedAt": None,
                "discoveredAt": None,
            }
        ]
    )
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): payload})

    result = read_api.get_video_ranking(_query(metric="total", contentType="live"))

    assert result["rows"] == []


def test_invalid_content_type_raises_client_error(monkeypatch):
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): _payload()})

    with pytest.raises(read_api.ClientError):
        read_api.get_video_ranking(_query(contentType="archived"))


def test_limit_truncates_the_served_rows(monkeypatch):
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): _payload()})

    result = read_api.get_video_ranking(_query(metric="total", limit=1))

    assert [row["videoId"] for row in result["rows"]] == ["v1"]


def test_a_video_missing_the_requested_metrics_anchor_is_excluded_not_fabricated(monkeypatch):
    """v2 has no anchor7dViewCount at all (a genuine gap) -- it must be
    excluded from the 7d ranking entirely, never given a fabricated 0."""
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): _payload()})

    result = read_api.get_video_ranking(_query(metric="7d"))

    assert [row["videoId"] for row in result["rows"]] == ["v1"]


def test_metadata_is_carried_into_the_response_rows(monkeypatch):
    payload = _payload(
        videos=[_canonical_row("v1", "valorant", 500, title="A Title", thumbnail_url="https://i.ytimg.com/vi/v1/x.jpg")]
    )
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): payload})

    result = read_api.get_video_ranking(_query(metric="total"))

    assert result["rows"][0]["title"] == "A Title"
    assert result["rows"][0]["thumbnailUrl"] == "https://i.ytimg.com/vi/v1/x.jpg"


# --- 2. invalid metric/topic --------------------------------------------------


def test_invalid_metric_raises_client_error(monkeypatch):
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): _payload()})

    with pytest.raises(read_api.ClientError):
        read_api.get_video_ranking(_query(metric="weekly"))


def test_missing_metric_raises_client_error(monkeypatch):
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): _payload()})

    with pytest.raises(read_api.ClientError):
        read_api.get_video_ranking({"creatorId": "aizawa_ema", "reportDate": "2026-09-29"})


def test_invalid_topic_raises_client_error(monkeypatch):
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): _payload()})

    with pytest.raises(read_api.ClientError):
        read_api.get_video_ranking(_query(topic="cooking"))


def test_unknown_creator_id_raises_client_error(monkeypatch):
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): _payload()})

    with pytest.raises(read_api.ClientError):
        read_api.get_video_ranking(_query(creatorId="not_a_real_creator"))


# --- 3. reportDate handling ----------------------------------------------------


def test_explicit_missing_report_date_is_ranking_not_ready_no_fallback(monkeypatch):
    _wire(monkeypatch, {("2026-09-28", "aizawa_ema"): _payload(reportDate="2026-09-28")})

    with pytest.raises(read_api.RankingNotReadyError):
        read_api.get_video_ranking(_query(reportDate="2026-09-29"))  # exact date only, no nearby fallback


def test_omitted_report_date_uses_the_bounded_latest_result_lookback(monkeypatch):
    monkeypatch.setattr(read_api, "_today_in_canonical_time_zone", lambda: date(2026, 9, 29))
    # Nothing for today, but yesterday's result exists within the lookback window.
    _wire(monkeypatch, {("2026-09-28", "aizawa_ema"): _payload(reportDate="2026-09-28")})

    result = read_api.get_video_ranking({"creatorId": "aizawa_ema", "metric": "total"})

    assert result["reportDate"] == "2026-09-28"  # the actual served date, not the omitted default


def test_missing_result_for_every_candidate_date_raises_ranking_not_ready(monkeypatch):
    monkeypatch.setattr(read_api, "_today_in_canonical_time_zone", lambda: date(2026, 9, 29))
    _wire(monkeypatch, {})

    with pytest.raises(read_api.RankingNotReadyError):
        read_api.get_video_ranking({"creatorId": "aizawa_ema", "metric": "total"})


def test_store_not_configured_is_ranking_not_ready_not_a_500(monkeypatch):
    class _UnconfiguredStoreClass:
        @classmethod
        def from_environment(cls, *, s3_client=None):
            return None

    monkeypatch.setattr(read_api, "S3VideoRankingStore", _UnconfiguredStoreClass)
    monkeypatch.setattr(read_api, "load_creators", lambda: DEFAULT_CREATORS)

    with pytest.raises(read_api.RankingNotReadyError):
        read_api.get_video_ranking(_query())


# --- 4. creator isolation at the API layer -------------------------------------


def test_one_creators_request_never_serves_another_creators_stored_result(monkeypatch):
    """The store is keyed by creatorId; a request for aizawa_ema must never
    read back other_creator's own object even if both exist for the same date."""
    _wire(
        monkeypatch,
        {
            ("2026-09-29", "aizawa_ema"): _payload(),
            (
                "2026-09-29",
                "other_creator",
            ): _payload(creatorId="other_creator", videos=[_canonical_row("z1", "other", 999_999, creator_id="other_creator")]),
        },
    )

    result = read_api.get_video_ranking(_query(creatorId="aizawa_ema", metric="total"))

    assert all(row["videoId"] != "z1" for row in result["rows"])
    assert result["creatorId"] == "aizawa_ema"


# --- 5. get_recent_creator_videos (newest-first, non-ranking) ------------------


def _recent_query(**overrides) -> dict:
    query = {"creatorId": "aizawa_ema", "reportDate": "2026-09-29"}
    query.update(overrides)
    return query


def test_recent_videos_are_ordered_newest_first_by_published_at(monkeypatch):
    payload = _payload(
        videos=[
            _canonical_row("v1", "valorant", 500, published_at="2026-09-01T00:00:00Z"),
            _canonical_row("v2", "sf6", 300, published_at="2026-09-20T00:00:00Z"),
            _canonical_row("v3", "apex", 100, published_at="2026-09-10T00:00:00Z"),
        ]
    )
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): payload})

    result = read_api.get_recent_creator_videos(_recent_query())

    assert [video["videoId"] for video in result["videos"]] == ["v2", "v3", "v1"]


def test_recent_videos_equal_published_at_break_ties_by_video_id(monkeypatch):
    payload = _payload(
        videos=[
            _canonical_row("v9", "valorant", 500, published_at="2026-09-10T00:00:00Z"),
            _canonical_row("v2", "sf6", 300, published_at="2026-09-10T00:00:00Z"),
        ]
    )
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): payload})

    result = read_api.get_recent_creator_videos(_recent_query())

    assert [video["videoId"] for video in result["videos"]] == ["v2", "v9"]


def test_recent_videos_content_type_live_excludes_upload_and_unclassified(monkeypatch):
    payload = _payload(
        videos=[
            _canonical_row("v1", "valorant", 500, content_type="live", published_at="2026-09-20T00:00:00Z"),
            _canonical_row("v2", "sf6", 300, content_type="upload", published_at="2026-09-25T00:00:00Z"),
            _canonical_row("v3", "apex", 100, content_type=None, published_at="2026-09-28T00:00:00Z"),
        ]
    )
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): payload})

    result = read_api.get_recent_creator_videos(_recent_query(contentType="live"))

    assert result["contentType"] == "live"
    assert [video["videoId"] for video in result["videos"]] == ["v1"]


def test_recent_videos_content_type_live_alone_includes_upcoming_and_live_not_just_completed(monkeypatch):
    """contentType="live" only reflects liveStreamingDetails presence, NOT
    lifecycle stage -- without an additional liveStatus filter, an upcoming
    or currently-live video is included right alongside completed archives.
    This is the exact conflation risk liveStatus exists to let a caller avoid."""
    payload = _payload(
        videos=[
            _canonical_row("v1", "valorant", 500, content_type="live", live_status="completed", published_at="2026-09-20T00:00:00Z"),
            _canonical_row("v2", "sf6", 300, content_type="live", live_status="live", published_at="2026-09-28T00:00:00Z"),
            _canonical_row("v3", "apex", 100, content_type="live", live_status="upcoming", published_at="2026-09-29T00:00:00Z"),
        ]
    )
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): payload})

    result = read_api.get_recent_creator_videos(_recent_query(contentType="live"))

    assert {video["videoId"] for video in result["videos"]} == {"v1", "v2", "v3"}


def test_live_status_completed_excludes_upcoming_and_currently_live(monkeypatch):
    """contentType=live&liveStatus=completed is the archive-only combination
    Home needs, to never duplicate the creator's own active/upcoming stream
    (which the separate Holodex-backed live path already owns)."""
    payload = _payload(
        videos=[
            _canonical_row("v1", "valorant", 500, content_type="live", live_status="completed", published_at="2026-09-20T00:00:00Z"),
            _canonical_row("v2", "sf6", 300, content_type="live", live_status="live", published_at="2026-09-28T00:00:00Z"),
            _canonical_row("v3", "apex", 100, content_type="live", live_status="upcoming", published_at="2026-09-29T00:00:00Z"),
        ]
    )
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): payload})

    result = read_api.get_recent_creator_videos(_recent_query(contentType="live", liveStatus="completed"))

    assert result["liveStatus"] == "completed"
    assert [video["videoId"] for video in result["videos"]] == ["v1"]


def test_live_status_defaults_to_all_when_omitted(monkeypatch):
    payload = _payload(
        videos=[
            _canonical_row("v1", "valorant", 500, content_type="live", live_status="completed"),
            _canonical_row("v2", "sf6", 300, content_type="live", live_status="upcoming"),
        ]
    )
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): payload})

    result = read_api.get_recent_creator_videos(_recent_query())

    assert result["liveStatus"] == "all"
    assert {video["videoId"] for video in result["videos"]} == {"v1", "v2"}


def test_invalid_live_status_raises_client_error(monkeypatch):
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): _payload()})

    with pytest.raises(read_api.ClientError):
        read_api.get_recent_creator_videos(_recent_query(liveStatus="ended"))


def test_recent_videos_content_type_defaults_to_all(monkeypatch):
    payload = _payload(
        videos=[
            _canonical_row("v1", "valorant", 500, content_type="live", published_at="2026-09-20T00:00:00Z"),
            _canonical_row("v2", "sf6", 300, content_type="upload", published_at="2026-09-25T00:00:00Z"),
        ]
    )
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): payload})

    result = read_api.get_recent_creator_videos(_recent_query())

    assert result["contentType"] == "all"
    assert {video["videoId"] for video in result["videos"]} == {"v1", "v2"}


def test_recent_videos_limit_and_offset_paginate_the_sorted_set(monkeypatch):
    payload = _payload(
        videos=[
            _canonical_row("v1", "x", 1, published_at="2026-09-25T00:00:00Z"),
            _canonical_row("v2", "x", 1, published_at="2026-09-24T00:00:00Z"),
            _canonical_row("v3", "x", 1, published_at="2026-09-23T00:00:00Z"),
            _canonical_row("v4", "x", 1, published_at="2026-09-22T00:00:00Z"),
            _canonical_row("v5", "x", 1, published_at="2026-09-21T00:00:00Z"),
        ]
    )
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): payload})

    page1 = read_api.get_recent_creator_videos(_recent_query(limit=2, offset=0))
    page2 = read_api.get_recent_creator_videos(_recent_query(limit=2, offset=2))
    page3 = read_api.get_recent_creator_videos(_recent_query(limit=2, offset=4))

    assert [v["videoId"] for v in page1["videos"]] == ["v1", "v2"]
    assert page1["hasMore"] is True
    assert [v["videoId"] for v in page2["videos"]] == ["v3", "v4"]
    assert page2["hasMore"] is True
    assert [v["videoId"] for v in page3["videos"]] == ["v5"]
    assert page3["hasMore"] is False


def test_recent_videos_has_more_is_false_when_the_last_page_is_shorter_than_limit(monkeypatch):
    """A naive `len(page) >= limit` would wrongly say hasMore=True here --
    exactly 5 videos exist, limit=2 offset=4 returns only 1, and nothing
    more follows."""
    payload = _payload(
        videos=[_canonical_row(f"v{i}", "x", 1, published_at=f"2026-09-{20 + i:02d}T00:00:00Z") for i in range(1, 6)]
    )
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): payload})

    result = read_api.get_recent_creator_videos(_recent_query(limit=2, offset=4))

    assert len(result["videos"]) == 1
    assert result["hasMore"] is False


def test_recent_videos_default_limit_is_four(monkeypatch):
    payload = _payload(
        videos=[
            _canonical_row(f"v{i}", "x", 1, published_at=f"2026-09-{20 + i:02d}T00:00:00Z") for i in range(1, 7)
        ]
    )
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): payload})

    result = read_api.get_recent_creator_videos(_recent_query())

    assert len(result["videos"]) == 4
    assert result["hasMore"] is True


def test_recent_videos_never_serves_another_creators_stored_result(monkeypatch):
    _wire(
        monkeypatch,
        {
            ("2026-09-29", "aizawa_ema"): _payload(),
            ("2026-09-29", "other_creator"): _payload(
                creatorId="other_creator", videos=[_canonical_row("z1", "other", 999_999, creator_id="other_creator")]
            ),
        },
    )

    result = read_api.get_recent_creator_videos(_recent_query(creatorId="aizawa_ema"))

    assert all(video["videoId"] != "z1" for video in result["videos"])
    assert result["creatorId"] == "aizawa_ema"


def test_recent_videos_unknown_creator_id_raises_client_error(monkeypatch):
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): _payload()})

    with pytest.raises(read_api.ClientError):
        read_api.get_recent_creator_videos(_recent_query(creatorId="not_a_real_creator"))


def test_recent_videos_invalid_content_type_raises_client_error(monkeypatch):
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): _payload()})

    with pytest.raises(read_api.ClientError):
        read_api.get_recent_creator_videos(_recent_query(contentType="archived"))


@pytest.mark.parametrize("bad_limit", [0, -1, "abc", 21])
def test_recent_videos_invalid_limit_raises_client_error(monkeypatch, bad_limit):
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): _payload()})

    with pytest.raises(read_api.ClientError):
        read_api.get_recent_creator_videos(_recent_query(limit=bad_limit))


@pytest.mark.parametrize("bad_offset", [-1, "abc"])
def test_recent_videos_invalid_offset_raises_client_error(monkeypatch, bad_offset):
    _wire(monkeypatch, {("2026-09-29", "aizawa_ema"): _payload()})

    with pytest.raises(read_api.ClientError):
        read_api.get_recent_creator_videos(_recent_query(offset=bad_offset))


def test_recent_videos_missing_result_for_every_candidate_date_raises_ranking_not_ready(monkeypatch):
    _wire(monkeypatch, {})

    with pytest.raises(read_api.RankingNotReadyError):
        read_api.get_recent_creator_videos(_recent_query())
