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
    anchor_1d: int | None = None,
    anchor_7d: int | None = None,
    anchor_30d: int | None = None,
    title: str | None = None,
    thumbnail_url: str | None = None,
) -> dict:
    return {
        "videoId": video_id,
        "creatorId": creator_id,
        "topic": topic,
        "currentViewCount": current_view_count,
        "anchor1dViewCount": anchor_1d,
        "anchor7dViewCount": anchor_7d,
        "anchor30dViewCount": anchor_30d,
        "title": title,
        "thumbnailUrl": thumbnail_url,
        "publishedAt": None,
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
