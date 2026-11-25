"""GET /creators/{creatorId}/videos/on-this-day (F37): same month/day, earlier years, dated by the verified actual start for livestreams
and by publishedAt for uploads, in an explicit time zone. Reads the same per-creator persisted result as the other Home endpoints."""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest

from api import api_handler, read_api
from api.read_api import ClientError
from tracking.creator_master import Creator

REPORT_DATE = "2026-10-27"
NOW = datetime(2026, 10, 28, 3, 0, tzinfo=timezone.utc)  # 2026-10-28 12:00 JST


def _creator(creator_id: str) -> Creator:
    return Creator(
        creator_id=creator_id, display_name=creator_id, organization="vspo", youtube_channel_id=f"UC_{creator_id}", active=True,
        branch="vspo_jp", group_key=["1"], channel_type="member", lifecycle_stage="active", display_order=0,
    )


def _live(video_id: str, start: str | None, *, published: str = "2020-01-01T00:00:00+00:00", status: str = "completed", topic: str = "chatting") -> dict:
    """A livestream catalog row; `start` is its actualStartAt (None = not captured yet)."""
    row = {
        "videoId": video_id, "creatorId": "emma", "topic": topic, "contentType": "live", "liveStatus": status, "currentViewCount": 10,
        "title": f"title {video_id}", "thumbnailUrl": None, "publishedAt": published, "discoveredAt": None,
    }
    if start is not None:
        row["actualStartAt"] = start
    return row


def _upload(video_id: str, published: str, *, content_type: str = "upload", topic: str = "chatting") -> dict:
    """An upload / Short catalog row dated by publishedAt."""
    return {
        "videoId": video_id, "creatorId": "emma", "topic": topic, "contentType": content_type, "liveStatus": None, "currentViewCount": 5,
        "title": f"title {video_id}", "thumbnailUrl": None, "publishedAt": published, "discoveredAt": None,
    }


def _wire(monkeypatch, rows: list[dict]) -> None:
    payload = {"schemaVersion": 2, "reportDate": REPORT_DATE, "creatorId": "emma", "generatedAt": f"{REPORT_DATE}T18:05:00+09:00", "videos": rows}

    class _Store:
        def read_result(self, report_date: date, creator_id: str):
            return payload if creator_id == "emma" else None

    class _StoreClass:
        @classmethod
        def from_environment_or_default(cls, *, s3_client=None):
            return _Store()

    monkeypatch.setattr(read_api, "S3VideoRankingStore", _StoreClass)
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("emma")])
    monkeypatch.setattr(read_api, "_leaderboard_report_dates", lambda raw: [date.fromisoformat(REPORT_DATE)])


def _query(month: int, day: int, **extra) -> dict:
    return read_api.get_creator_videos_on_this_day({"creatorId": "emma", "month": str(month), "day": str(day), **extra}, now=NOW)


def _ids(result: dict) -> list[list[str]]:
    return [[v["videoId"] for v in year["videos"]] for year in result["years"]]


def test_groups_the_same_month_day_by_year_newest_year_first(monkeypatch):
    """Matches across years, newest year first, newest first inside a year; other dates are ignored."""
    _wire(monkeypatch, [
        _live("a2023", "2023-03-15T10:00:00+00:00"), _live("a2025", "2025-03-15T10:00:00+00:00"),
        _live("a2025b", "2025-03-15T12:00:00+00:00"), _live("other", "2025-03-16T10:00:00+00:00"),
    ])
    result = _query(3, 15)
    assert [y["year"] for y in result["years"]] == [2025, 2023]
    assert _ids(result) == [["a2025b", "a2025"], ["a2023"]]
    assert result["total"] == 3 and result["truncated"] is False
    assert result["years"][0]["videos"][0]["date"] == "2025-03-15"


def test_livestream_is_dated_by_actual_start_never_by_published_at(monkeypatch):
    """A stream published on Mar 15 but started Mar 14 belongs to Mar 14; its dateKind says so."""
    _wire(monkeypatch, [_live("s", "2024-03-14T10:00:00+00:00", published="2024-03-15T10:00:00+00:00")])
    assert _ids(_query(3, 15)) == []
    result = _query(3, 14)
    assert _ids(result) == [["s"]]
    assert result["years"][0]["videos"][0]["dateKind"] == "actualStart"


def test_livestream_without_a_start_is_undated_and_counted_not_guessed(monkeypatch):
    """No actualStartAt: never placed by publishedAt, and disclosed in coverage."""
    _wire(monkeypatch, [_live("nostart", None, published="2024-03-15T10:00:00+00:00"), _live("dated", "2024-03-15T10:00:00+00:00")])
    result = _query(3, 15)
    assert _ids(result) == [["dated"]]
    assert result["coverage"]["undatedLivestreams"] == 1
    assert result["coverage"]["catalogRows"] == 2


def test_uploads_shorts_and_premieres_use_published_at(monkeypatch):
    """An upload (including a Premiere) and a Short are dated by publishedAt with dateKind published."""
    _wire(monkeypatch, [_upload("u", "2024-03-15T10:00:00+00:00"), _upload("sh", "2023-03-15T10:00:00+00:00", content_type="short")])
    result = _query(3, 15)
    assert _ids(result) == [["u"], ["sh"]]
    assert {v["dateKind"] for y in result["years"] for v in y["videos"]} == {"published"}


def test_jst_utc_boundary_follows_the_requested_time_zone(monkeypatch):
    """16:30 UTC on Mar 14 is 01:30 JST on Mar 15: Asia/Tokyo (default) files it under 15, UTC under 14."""
    _wire(monkeypatch, [_live("late", "2024-03-14T16:30:00+00:00")])
    assert _ids(_query(3, 15)) == [["late"]]
    assert result_zone(_query(3, 15)) == "Asia/Tokyo"
    assert _ids(_query(3, 14)) == []
    assert _ids(_query(3, 14, timeZone="UTC")) == [["late"]]
    assert _ids(_query(3, 15, timeZone="UTC")) == []


def result_zone(result: dict) -> str:
    """The zone the response says it used."""
    return result["timeZone"]


def test_february_29_matches_only_leap_years(monkeypatch):
    """Feb 29 exists in 2024 only; it is a valid query, and Feb 28 / Mar 1 of other years are not folded into it."""
    _wire(monkeypatch, [_live("leap", "2024-02-29T10:00:00+00:00"), _live("n28", "2025-02-28T10:00:00+00:00"), _live("m1", "2025-03-01T10:00:00+00:00")])
    assert _ids(_query(2, 29)) == [["leap"]]
    with pytest.raises(ClientError):
        _query(2, 30)


def test_today_the_future_and_in_progress_streams_are_not_memories(monkeypatch):
    """Today's local date (JST) is excluded, last year's same date is included, and upcoming/live streams never appear."""
    _wire(monkeypatch, [
        _live("today", "2026-10-28T01:00:00+00:00"), _live("lastyear", "2025-10-28T01:00:00+00:00"),
        _live("up", "2024-10-28T01:00:00+00:00", status="upcoming"), _live("on", "2023-10-28T01:00:00+00:00", status="live"),
    ])
    assert _ids(_query(10, 28)) == [["lastyear"]]


def test_duplicates_are_returned_once(monkeypatch):
    """A repeated videoId is listed once."""
    row = _live("dup", "2024-03-15T10:00:00+00:00")
    _wire(monkeypatch, [row, dict(row)])
    assert _ids(_query(3, 15)) == [["dup"]]


def test_topic_content_type_and_shorts_filters_reuse_the_existing_semantics(monkeypatch):
    """topic / contentType / excludeShorts narrow the set exactly as they do on /videos/recent."""
    _wire(monkeypatch, [
        _live("game", "2024-03-15T10:00:00+00:00", topic="minecraft"), _live("chat", "2023-03-15T10:00:00+00:00", topic="chatting"),
        _upload("short", "2022-03-15T10:00:00+00:00", content_type="short"), _upload("vid", "2021-03-15T10:00:00+00:00"),
    ])
    assert _ids(_query(3, 15, topic="minecraft")) == [["game"]]
    assert _ids(_query(3, 15, contentType="upload")) == [["vid"]]
    assert _ids(_query(3, 15, contentType="live")) == [["game"], ["chat"]]
    assert _ids(_query(3, 15, excludeShorts="true")) == [["game"], ["chat"], ["vid"]]


def test_unclassified_rows_are_undated(monkeypatch):
    """A row with no contentType could be a livestream, so it is not dated by publishedAt and is counted."""
    row = _upload("x", "2024-03-15T10:00:00+00:00")
    row["contentType"] = None
    _wire(monkeypatch, [row])
    result = _query(3, 15)
    assert result["total"] == 0 and result["coverage"]["unclassified"] == 1


def test_coverage_reports_the_catalog_start_in_the_requested_zone(monkeypatch):
    """catalogStart is the earliest dated row's local date, so the UI can say what the catalog covers."""
    _wire(monkeypatch, [_live("old", "2019-07-17T15:30:00+00:00"), _live("new", "2025-01-01T00:00:00+00:00")])
    assert _query(1, 1)["coverage"]["catalogStart"] == "2019-07-18"  # 15:30 UTC = 00:30 JST next day


def test_bad_input_and_route_registration(monkeypatch):
    """Month/day must form a real date, a bad zone is rejected, and the route is registered."""
    _wire(monkeypatch, [])
    for month, day in ((13, 1), (0, 1), (4, 31), ("x", 1), (None, None)):
        with pytest.raises(ClientError):
            read_api.get_creator_videos_on_this_day({"creatorId": "emma", "month": month, "day": day}, now=NOW)
    with pytest.raises(ClientError):
        _query(3, 15, timeZone="Mars/Base")
    assert api_handler._ROUTES["GET /creators/{creatorId}/videos/on-this-day"] is api_handler._handle_get_creator_videos_on_this_day
