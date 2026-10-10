"""B18: Home's 最新影片 = all topics + normal uploaded videos only + NOT Shorts + publishedAt DESC.

A Short is stored as contentType="short" (decided from the channel's Shorts shelf, see tracking.video_master); the shelf
asks for contentType=upload, so Shorts fall out of it by the same strict contentType equality that separates uploads
from livestreams -- not by duration and not by a "#shorts" title."""

from __future__ import annotations

from datetime import date

import pytest

from api import read_api
from tracking.creator_master import Creator

REPORT_DATE = "2026-10-01"
CREATOR = "emma"


def _row(video_id: str, content_type: str | None, published: str, *, topic: str = "other", live_status: str | None = None, title: str | None = None) -> dict:
    return {
        "videoId": video_id,
        "creatorId": CREATOR,
        "topic": topic,
        "contentType": content_type,
        "liveStatus": live_status,
        "currentViewCount": 1000,
        "anchor1dViewCount": None,
        "anchor7dViewCount": None,
        "anchor30dViewCount": None,
        "title": title or f"title {video_id}",
        "thumbnailUrl": None,
        "publishedAt": published,
        "discoveredAt": None,
    }


# A realistic mix, newest first: the Shorts cluster at the very top, exactly the symptom this fixes.
ROWS = [
    _row("short-newest", "short", "2026-09-30T08:00:00Z", title="ゎ/癒月ちょこ"),  # no hashtag at all
    _row("short-mv", "short", "2026-09-29T08:00:00Z", topic="mv", title="【Cover】short clip #shorts"),
    _row("upload-new", "upload", "2026-09-28T10:00:00Z"),
    _row("upload-mv", "upload", "2026-09-27T10:00:00Z", topic="mv", title="【MV】Original Song"),
    _row("stream-done", "live", "2026-09-26T10:00:00Z", live_status="completed"),
    _row("upload-old", "upload", "2026-09-20T10:00:00Z"),
    _row("tagged-upload", "upload", "2026-09-19T10:00:00Z", title="雑談 #shorts"),  # a hashtag does not make it a Short
    _row("unclassified", None, "2026-09-18T10:00:00Z"),
]


@pytest.fixture
def stored(monkeypatch):
    payload = {"schemaVersion": 2, "reportDate": REPORT_DATE, "creatorId": CREATOR, "generatedAt": f"{REPORT_DATE}T18:05:00+09:00", "videos": ROWS}

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


def _recent_ids(**query) -> list[str]:
    response = read_api.get_recent_creator_videos({"creatorId": CREATOR, "reportDate": REPORT_DATE, "limit": "20", **query})
    return [video["videoId"] for video in response["videos"]]


def _ranking_ids(**query) -> list[str]:
    response = read_api.get_video_ranking({"creatorId": CREATOR, "reportDate": REPORT_DATE, "metric": "total", **query})
    return [row["videoId"] for row in response["rows"]]


def test_the_latest_video_shelf_has_no_shorts_all_topics_normal_uploads_newest_first(stored):
    assert _recent_ids(topic="all", contentType="upload", liveStatus="archived", sort="newest") == [
        "upload-new",
        "upload-mv",
        "upload-old",
        "tagged-upload",
    ]


def test_the_topic_filtered_video_shelf_has_no_shorts_either(stored):
    assert _recent_ids(topic="mv", contentType="upload", liveStatus="archived") == ["upload-mv"]


def test_a_shorts_hashtag_in_a_title_does_not_exclude_a_normal_upload_and_a_hashtag_less_short_is_still_excluded(stored):
    ids = _recent_ids(topic="all", contentType="upload", liveStatus="archived")
    assert "tagged-upload" in ids
    assert "short-newest" not in ids


def test_livestream_results_never_contain_shorts(stored):
    assert _recent_ids(topic="all", contentType="live", liveStatus="archived") == ["stream-done"]


def test_shorts_are_addressable_for_the_future_shelf_and_are_still_part_of_all(stored):
    assert _recent_ids(topic="all", contentType="short", liveStatus="archived") == ["short-newest", "short-mv"]
    all_ids = _recent_ids(topic="all", contentType="all", liveStatus="archived")
    assert {"short-newest", "short-mv", "upload-new", "stream-done"} <= set(all_ids)


def test_the_short_filter_excludes_uploads_and_livestreams_and_sorts_and_pages_like_any_shelf(stored):
    """B23: the Video List's Short filter is just contentType=short on the existing endpoint."""
    for live_status in ("archived", "all"):
        ids = _recent_ids(topic="all", contentType="short", liveStatus=live_status)
        assert ids == ["short-newest", "short-mv"]
        assert not {"upload-new", "stream-done", "tagged-upload", "unclassified"} & set(ids)
    assert _recent_ids(topic="all", contentType="short", liveStatus="archived", sort="oldest") == ["short-mv", "short-newest"]
    assert _recent_ids(topic="all", contentType="short", liveStatus="archived", limit="1", offset="1") == ["short-mv"]
    response = read_api.get_recent_creator_videos(
        {"creatorId": CREATOR, "reportDate": REPORT_DATE, "contentType": "short", "liveStatus": "archived", "limit": "1"}
    )
    assert response["hasMore"] is True


def test_the_ranking_endpoint_has_the_same_split(stored):
    assert set(_ranking_ids(contentType="upload", liveStatus="archived", limit="100")) == {"upload-new", "upload-mv", "upload-old", "tagged-upload"}
    assert set(_ranking_ids(contentType="short", liveStatus="archived", limit="100")) == {"short-newest", "short-mv"}


def test_an_unknown_content_type_is_still_a_client_error(stored):
    with pytest.raises(read_api.ClientError):
        read_api.get_recent_creator_videos({"creatorId": CREATOR, "reportDate": REPORT_DATE, "contentType": "reel"})
