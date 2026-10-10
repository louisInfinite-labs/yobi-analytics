"""A cover MV published as a YouTube Premiere is a VIDEO, not livestream content: raw videos.list item -> contentType/
liveStatus -> topic -> the Home shelf's filters. Premiere metadata (liveStreamingDetails) alone must not file it under
the livestream-only results; a real livestream keeps governing by its real live status."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from api import read_api
from collection.youtube_client import _parse_video_item
from tracking.creator_master import Creator
from tracking.video_topics import classify_video_topic

REPORT_DATE = "2026-10-01"
CREATOR = "emma"


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _item(video_id: str, title: str, published: datetime, live: dict | None = None) -> dict:
    item = {"id": video_id, "snippet": {"title": title, "publishedAt": _iso(published)}, "statistics": {"viewCount": "1000"}}
    if live is not None:
        item["liveStreamingDetails"] = live
    return item


BASE = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)


def _premiere(published_offset_s: int = 0) -> dict:
    """A completed Premiere: published at (about) its own start, a few minutes long."""
    start = BASE + timedelta(days=5)
    return _item(
        "cover-premiere",
        "【Cover】Nostalgia / covered by Emma",
        start + timedelta(seconds=published_offset_s),
        {"scheduledStartTime": _iso(start), "actualStartTime": _iso(start), "actualEndTime": _iso(start + timedelta(minutes=4))},
    )


def _stream_archive() -> dict:
    """A real MV livestream (e.g. a watch-along): published hours AFTER it ended."""
    start = BASE + timedelta(days=3)
    return _item(
        "mv-livestream",
        "【MV 同時視聴】新曲MVをみんなで見る",
        start + timedelta(hours=5),
        {"scheduledStartTime": _iso(start), "actualStartTime": _iso(start), "actualEndTime": _iso(start + timedelta(hours=3))},
    )


def _singing_archive() -> dict:
    start = BASE + timedelta(days=2)
    return _item(
        "singing-livestream",
        "【歌枠】のんびり歌う",
        start + timedelta(hours=4),
        {"scheduledStartTime": _iso(start), "actualStartTime": _iso(start), "actualEndTime": _iso(start + timedelta(hours=2))},
    )


def _upcoming_premiere() -> dict:
    start = BASE + timedelta(days=9)
    return _item("upcoming-premiere", "【MV】Original Song 公開予定", start - timedelta(days=1), {"scheduledStartTime": _iso(start)})


def _plain_mv_upload() -> dict:
    return _item("mv-upload", "【MV】Original Song", BASE + timedelta(days=4))


def _stored_row(item: dict) -> dict:
    parsed = _parse_video_item(item)
    return {
        "videoId": parsed["videoId"],
        "creatorId": CREATOR,
        "topic": classify_video_topic(parsed["title"]),
        "contentType": parsed["contentType"],
        "liveStatus": parsed["liveStatus"],
        "currentViewCount": parsed["viewCount"],
        "anchor1dViewCount": None,
        "anchor7dViewCount": None,
        "anchor30dViewCount": None,
        "title": parsed["title"],
        "thumbnailUrl": None,
        "publishedAt": parsed["publishedAt"],
        "discoveredAt": None,
    }


@pytest.fixture
def stored(monkeypatch):
    rows = [
        _stored_row(item)
        for item in (_plain_mv_upload(), _premiere(), _stream_archive(), _singing_archive(), _upcoming_premiere())
    ]
    payload = {"schemaVersion": 2, "reportDate": REPORT_DATE, "creatorId": CREATOR, "generatedAt": f"{REPORT_DATE}T18:05:00+09:00", "videos": rows}

    class _Store:
        @classmethod
        def from_environment_or_default(cls, *, s3_client=None):
            return cls()

        def read_result(self, report_date: date, creator_id: str):
            return payload if creator_id == CREATOR else None

    creator = Creator(
        creator_id=CREATOR, display_name=CREATOR, organization="vspo", youtube_channel_id="UC_emma", active=True,
        branch="vspo_jp", group_key=["1期生"], channel_type="member", lifecycle_stage="active", display_order=0,
    )
    monkeypatch.setattr(read_api, "S3VideoRankingStore", _Store)
    monkeypatch.setattr(read_api, "load_creators", lambda: [creator])
    return {row["videoId"]: row for row in rows}


def _recent_ids(**query) -> list[str]:
    response = read_api.get_recent_creator_videos({"creatorId": CREATOR, "reportDate": REPORT_DATE, "limit": "20", **query})
    return [video["videoId"] for video in response["videos"]]


def test_a_plain_mv_upload_is_a_video_with_the_mv_topic():
    parsed = _parse_video_item(_plain_mv_upload())
    assert (parsed["contentType"], parsed["liveStatus"]) == ("upload", None)
    assert classify_video_topic(parsed["title"]) == "mv"


def test_a_completed_cover_mv_premiere_is_a_video_with_the_mv_topic_not_a_livestream():
    parsed = _parse_video_item(_premiere())
    assert (parsed["contentType"], parsed["liveStatus"]) == ("upload", None)
    assert classify_video_topic(parsed["title"]) == "mv"


@pytest.mark.parametrize("published_offset_s", [-126, -60, 0, 3])
def test_the_audited_premiere_publish_window_is_still_a_video(published_offset_s):
    assert _parse_video_item(_premiere(published_offset_s))["contentType"] == "upload"


def test_a_real_livestream_archive_stays_live_and_completed_even_with_an_mv_topic():
    parsed = _parse_video_item(_stream_archive())
    assert (parsed["contentType"], parsed["liveStatus"]) == ("live", "completed")
    assert classify_video_topic(parsed["title"]) == "mv"


def test_an_upcoming_premiere_without_contentdetails_is_unknown_so_it_stays_governed_by_its_live_status():
    """No contentDetails at all is "unknown" (fail open: never hides a real stream); the real response shape is covered in
    test_youtube_client.py (an upcoming Premiere reports no duration)."""
    parsed = _parse_video_item(_upcoming_premiere())
    assert (parsed["contentType"], parsed["liveStatus"]) == ("live", "upcoming")


def test_an_upcoming_premiere_with_the_real_no_duration_shape_is_a_video_and_a_real_upcoming_stream_is_not():
    premiere = _upcoming_premiere()
    premiere["snippet"]["liveBroadcastContent"] = "upcoming"
    premiere["contentDetails"] = {"dimension": "2d", "definition": "hd"}  # no duration, as the real Data API returns for an upcoming Premiere
    stream = _item("real-upcoming", "【雑談】明日の予定", BASE, {"scheduledStartTime": _iso(BASE + timedelta(days=1))})
    stream["snippet"]["liveBroadcastContent"] = "upcoming"
    stream["contentDetails"] = {"dimension": "2d", "definition": "hd", "duration": "P0D"}

    assert _parse_video_item(premiere)["contentType"] == "upload"
    assert (_parse_video_item(stream)["contentType"], _parse_video_item(stream)["liveStatus"]) == ("live", "upcoming")


def test_video_plus_mv_includes_the_upload_and_the_premiere_and_nothing_live(stored):
    assert _recent_ids(topic="mv", contentType="upload", liveStatus="archived") == ["cover-premiere", "mv-upload"]


def test_livestream_plus_mv_excludes_the_premiere_and_the_plain_upload(stored):
    assert _recent_ids(topic="mv", contentType="live", liveStatus="archived") == ["mv-livestream"]


def test_a_completed_livestream_archive_with_an_mv_topic_does_not_become_an_uploaded_mv(stored):
    assert "mv-livestream" not in _recent_ids(topic="mv", contentType="upload", liveStatus="archived")


def test_the_two_home_quick_filters_split_on_the_real_content_type(stored):
    latest_videos = _recent_ids(topic="all", contentType="upload", liveStatus="archived")
    latest_live = _recent_ids(topic="all", contentType="live", liveStatus="archived")

    assert set(latest_videos) == {"mv-upload", "cover-premiere"}
    assert set(latest_live) == {"mv-livestream", "singing-livestream"}
    assert not set(latest_videos) & set(latest_live)


def test_an_upcoming_stream_is_governed_by_its_real_live_status_not_by_the_mv_topic(stored):
    assert "upcoming-premiere" not in _recent_ids(topic="mv", contentType="live", liveStatus="archived")
    assert "upcoming-premiere" in _recent_ids(topic="mv", contentType="live", liveStatus="upcoming")
