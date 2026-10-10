"""B23 follow-up: Short is its own Video List category, so a topic filter must not also list that topic's Shorts.

`excludeShorts=true` is an explicit, additive filter on the existing per-creator endpoints: it drops contentType="short"
rows after every other filter and before sorting/paging. It does NOT redefine contentType=all (every other consumer keeps
getting every row), and it never touches a stored topic."""

from __future__ import annotations

from datetime import date

import pytest

from api import read_api
from tracking.creator_master import Creator

REPORT_DATE = "2026-10-01"
CREATOR = "emma"


def _row(video_id: str, content_type: str | None, published: str, *, topic: str, live_status: str | None = None) -> dict:
    return {
        "videoId": video_id, "creatorId": CREATOR, "topic": topic, "contentType": content_type, "liveStatus": live_status,
        "currentViewCount": 1000, "anchor1dViewCount": None, "anchor7dViewCount": None, "anchor30dViewCount": None,
        "title": f"title {video_id}", "thumbnailUrl": None, "publishedAt": published, "discoveredAt": None,
    }


ROWS = [
    _row("valo-short", "short", "2026-09-30T08:00:00Z", topic="valorant"),
    _row("valo-upload", "upload", "2026-09-29T08:00:00Z", topic="valorant"),
    _row("valo-stream", "live", "2026-09-28T08:00:00Z", topic="valorant", live_status="completed"),
    _row("mv-short", "short", "2026-09-27T08:00:00Z", topic="mv"),
    _row("mv-upload", "upload", "2026-09-26T08:00:00Z", topic="mv"),
    _row("mv-stream", "live", "2026-09-25T08:00:00Z", topic="mv", live_status="completed"),
    _row("other-short", "short", "2026-09-24T08:00:00Z", topic="other"),
    _row("other-upload", "upload", "2026-09-23T08:00:00Z", topic="other"),
    _row("other-unclassified", None, "2026-09-22T08:00:00Z", topic="other"),
    _row("valo-live-now", "live", "2026-09-21T08:00:00Z", topic="valorant", live_status="live"),
    _row("mv-upcoming", "live", "2026-09-20T08:00:00Z", topic="mv", live_status="upcoming"),
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


def _recent(**query) -> dict:
    return read_api.get_recent_creator_videos({"creatorId": CREATOR, "reportDate": REPORT_DATE, "limit": "20", **query})


def _ids(**query) -> list[str]:
    return [video["videoId"] for video in _recent(**query)["videos"]]


def _ranking_ids(**query) -> list[str]:
    return [row["videoId"] for row in read_api.get_video_ranking({"creatorId": CREATOR, "reportDate": REPORT_DATE, "metric": "total", "limit": "100", **query})["rows"]]


def test_a_topic_filter_without_shorts_hides_that_topics_shorts_and_keeps_its_normal_content(stored):
    assert _ids(topic="valorant", excludeShorts="true", liveStatus="archived") == ["valo-upload", "valo-stream"]
    assert _ids(topic="mv", excludeShorts="true", liveStatus="archived") == ["mv-upload", "mv-stream"]
    assert _ids(topic="other", excludeShorts="true", liveStatus="archived") == ["other-upload", "other-unclassified"]


def test_the_short_filter_still_returns_those_shorts_across_every_topic(stored):
    assert _ids(topic="all", contentType="short", liveStatus="archived") == ["valo-short", "mv-short", "other-short"]
    assert _ids(topic="valorant", contentType="short", liveStatus="archived") == ["valo-short"]


def test_the_stored_topic_of_a_short_is_untouched(stored):
    shorts = {video["videoId"]: video["topic"] for video in _recent(topic="all", contentType="short")["videos"]}
    assert shorts == {"valo-short": "valorant", "mv-short": "mv", "other-short": "other"}


def test_content_type_all_alone_keeps_its_meaning_every_row_including_shorts(stored):
    assert "valo-short" in _ids(topic="valorant", contentType="all", liveStatus="archived")
    assert "valo-short" in _ids(topic="valorant", liveStatus="all")
    assert len(_ids(topic="all", contentType="all", liveStatus="all")) == len(ROWS)


def test_excludeShorts_composes_with_the_other_content_types(stored):
    assert _ids(topic="mv", contentType="upload", excludeShorts="true", liveStatus="archived") == ["mv-upload"]
    assert _ids(topic="mv", contentType="live", excludeShorts="true", liveStatus="archived") == ["mv-stream"]
    assert _ids(topic="all", contentType="short", excludeShorts="true") == []  # contradictory on purpose: nothing, not an error


def test_live_and_upcoming_streams_are_unaffected_by_the_flag(stored):
    assert _ids(topic="valorant", excludeShorts="true", liveStatus="live") == ["valo-live-now"]
    assert _ids(topic="mv", excludeShorts="true", liveStatus="upcoming") == ["mv-upcoming"]
    assert _ids(topic="all", excludeShorts="true", liveStatus="all") == [row["videoId"] for row in ROWS if row["contentType"] != "short"]


def test_paging_and_hasMore_are_computed_after_the_shorts_are_dropped(stored):
    first = _recent(topic="all", excludeShorts="true", liveStatus="archived", limit="3")
    assert [video["videoId"] for video in first["videos"]] == ["valo-upload", "valo-stream", "mv-upload"]
    assert first["hasMore"] is True  # mv-stream, other-upload, other-unclassified remain

    last = _recent(topic="all", excludeShorts="true", liveStatus="archived", limit="3", offset="3")
    assert [video["videoId"] for video in last["videos"]] == ["mv-stream", "other-upload", "other-unclassified"]
    assert last["hasMore"] is False  # the 3 Shorts must not count toward "more"

    # A page that WOULD end on a Short without the filter reports no more once the Shorts are removed.
    only_normal = _recent(topic="valorant", excludeShorts="true", liveStatus="archived", limit="2")
    assert [video["videoId"] for video in only_normal["videos"]] == ["valo-upload", "valo-stream"]
    assert only_normal["hasMore"] is False
    assert _recent(topic="valorant", liveStatus="archived", limit="2")["hasMore"] is True  # without the flag the Short is still ahead


def test_the_oldest_sort_and_the_ranking_endpoint_apply_the_same_rule(stored):
    assert _ids(topic="mv", excludeShorts="true", liveStatus="archived", sort="oldest") == ["mv-stream", "mv-upload"]
    assert set(_ranking_ids(topic="valorant", excludeShorts="true", liveStatus="archived")) == {"valo-upload", "valo-stream"}
    assert set(_ranking_ids(topic="valorant", liveStatus="archived")) == {"valo-short", "valo-upload", "valo-stream"}


@pytest.mark.parametrize("raw", ["TRUE", " true ", "True"])
def test_the_flag_is_case_and_whitespace_tolerant(stored, raw):
    assert _ids(topic="mv", excludeShorts=raw, liveStatus="archived") == ["mv-upload", "mv-stream"]


@pytest.mark.parametrize("raw", [None, "", "false", "FALSE"])
def test_absent_or_false_means_unchanged_behaviour(stored, raw):
    query = {} if raw is None else {"excludeShorts": raw}
    assert "mv-short" in _ids(topic="mv", liveStatus="archived", **query)


@pytest.mark.parametrize("raw", ["yes", "1", "short", True])
def test_an_unrecognised_flag_is_a_client_error(stored, raw):
    with pytest.raises(read_api.ClientError):
        _recent(topic="mv", excludeShorts=raw)
