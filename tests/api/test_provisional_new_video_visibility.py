"""Home's 最新影片 / ALL / Short shelves list a video discovered AFTER the last daily ranking run, provisionally, before the next 18:00 JST run.

Pinned here: a missing/unknown contentType never hides the video, the 60-second Short boundary, livestreams are never listed, nothing is
persisted, and the daily run's own row replaces the provisional one (reconciliation).
"""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest

from api import provisional_discoveries as pd
from api import read_api
from collection import youtube_client
from tracking.creator_master import Creator

CREATOR = "nekomata_okayu"
OTHER = "usada_pekora"
VIDEO = "_wFR042t70Q"
GENERATED_AT = "2026-10-16T18:01:49+09:00"
LATEST_VIDEOS = {"creatorId": CREATOR, "contentType": "upload", "liveStatus": "archived", "topic": "all", "sort": "newest", "limit": "20", "offset": "0"}
ALL_TAG = {**LATEST_VIDEOS, "contentType": "all", "excludeShorts": "true"}
SHORT_TAG = {**LATEST_VIDEOS, "contentType": "short"}
LIVE_TAG = {**LATEST_VIDEOS, "contentType": "live"}


def _creator(creator_id: str) -> Creator:
    """A minimal active member creator."""
    return Creator(
        creator_id=creator_id, display_name=creator_id, organization="hololive", youtube_channel_id=f"UC_{creator_id}", active=True,
        branch="holo_jp", group_key=["ゲーマーズ"], channel_type="member", lifecycle_stage="active", display_order=0,
    )


def _persisted(video_id: str, published: str, *, content_type="upload", title=None) -> dict:
    """A row as the daily 18:00 run persisted it."""
    title = title or f"title {video_id}"
    return {
        "videoId": video_id, "creatorId": CREATOR, "topic": "other", "contentType": content_type, "liveStatus": None, "currentViewCount": 10,
        "title": title, "thumbnailUrl": None, "publishedAt": published, "discoveredAt": "2026-07-14T19:00:00+09:00",
    }


def _event(video_id: str = VIDEO, *, creator_id: str = CREATOR, content_type: str | None = None, title: str = "モニタリング (cover)") -> dict:
    """A discovery event as run_discovery records it."""
    event = {
        "eventDate": "2026-10-16", "videoId": video_id, "eventId": f"new_video:{video_id}", "creatorId": creator_id, "title": title,
        "publishedAt": "2026-10-16T09:00:24Z", "discoveredAt": "2026-10-16T20:00:42+09:00", "discoverySource": "discovery_window:2000",
        "notificationEligible": True,
    }
    if content_type:
        event["contentType"] = content_type
    return event


@pytest.fixture
def home(monkeypatch):
    """The persisted ranking, the discovery events and the YouTube answers, all in memory; records every lookup."""
    state = {"rows": [_persisted("old1", "2026-07-14T10:00:06Z")], "events": [], "facts": {}, "asked": [], "fail_lookup": False}

    class _Store:
        @classmethod
        def from_environment_or_default(cls, *, s3_client=None):
            """From environment or default."""
            return cls()

        def read_result(self, report_date: date, creator_id: str):
            """Read result."""
            return {"schemaVersion": 2, "reportDate": "2026-10-16", "creatorId": creator_id, "generatedAt": GENERATED_AT, "videos": state["rows"]}

    def fetch(video_ids):
        state["asked"].append(list(video_ids))
        if state["fail_lookup"]:
            raise RuntimeError("quota")
        return {video_id: state["facts"][video_id] for video_id in video_ids if video_id in state["facts"]}

    monkeypatch.setattr(read_api, "S3VideoRankingStore", _Store)
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(CREATOR), _creator(OTHER)])
    monkeypatch.setattr(read_api, "_read_available_archives", lambda creator_id: [])
    monkeypatch.setenv("YOBI_STORAGE_BACKEND", "dynamodb")
    monkeypatch.setattr(pd, "_events_for_date", lambda event_date, moment: list(state["events"]))
    monkeypatch.setattr(pd, "_fetch_facts", fetch)
    return state


def _ids(**query) -> list[str]:
    """Video ids Home's shelf returns for a query."""
    return [video["videoId"] for video in read_api.get_recent_creator_videos(query)["videos"]]


def _facts(content_type="upload", live_status=None, duration=177) -> dict:
    """What the YouTube lookup answers for one video."""
    return {"contentType": content_type, "liveStatus": live_status, "durationSeconds": duration}


# ============ a missing / unknown contentType never hides a newly discovered video ============


def test_a_discovered_video_with_no_classification_is_listed_in_latest_videos_and_all_before_the_daily_run(home):
    home["events"] = [_event()]
    home["fail_lookup"] = True  # nothing is known about it: no contentType, no duration

    assert _ids(**LATEST_VIDEOS) == [VIDEO, "old1"]  # newest first
    assert _ids(**ALL_TAG) == [VIDEO, "old1"]
    [row] = [v for v in read_api.get_recent_creator_videos(LATEST_VIDEOS)["videos"] if v["videoId"] == VIDEO]
    assert row["contentType"] is None and row["provisional"] is True  # the official contentType is never invented
    assert row["publishedAt"] == "2026-10-16T09:00:24Z" and row["discoveredAt"] == "2026-10-16T20:00:42+09:00"
    assert row["thumbnailUrl"] == f"https://i.ytimg.com/vi/{VIDEO}/hqdefault.jpg" and row["topic"] != ""


def test_an_unclassified_provisional_video_is_not_a_short_or_a_livestream_candidate(home):
    home["events"] = [_event()]
    home["fail_lookup"] = True

    assert VIDEO not in _ids(**SHORT_TAG)
    assert VIDEO not in _ids(**LIVE_TAG)


def test_a_video_the_lookup_cannot_return_stays_listed(home):
    home["events"] = [_event()]  # YouTube answers for no id (private / deleted / hidden view count)

    assert VIDEO in _ids(**LATEST_VIDEOS)


def test_a_classified_upload_is_listed_as_an_upload_but_still_provisional(home):
    home["events"] = [_event()]
    home["facts"] = {VIDEO: _facts("upload", None, 177)}

    [row] = [v for v in read_api.get_recent_creator_videos(LATEST_VIDEOS)["videos"] if v["videoId"] == VIDEO]
    assert row["contentType"] == "upload" and row["provisional"] is True


# ============ the 60-second Short boundary ============


@pytest.mark.parametrize(
    ("duration", "is_short"),
    [(1, True), (59, True), (60, False), (61, False), (177, False), (None, False), (0, False)],
)
def test_duration_decides_short_versus_video_at_sixty_seconds_and_unknown_is_a_video(home, duration, is_short):
    home["events"] = [_event()]
    home["facts"] = {VIDEO: _facts("upload", None, duration)}

    assert (VIDEO in _ids(**SHORT_TAG)) is is_short
    assert (VIDEO in _ids(**LATEST_VIDEOS)) is not is_short
    assert (VIDEO in _ids(**ALL_TAG)) is not is_short  # ALL never lists a Short


def test_a_channel_shorts_shelf_video_is_listed_as_a_short_without_any_lookup(home):
    home["events"] = [_event(content_type="short")]

    assert VIDEO in _ids(**SHORT_TAG)
    assert VIDEO not in _ids(**LATEST_VIDEOS)
    assert home["asked"] == []  # the Shorts shelf membership is authoritative; no YouTube request is spent on it


# ============ livestreams, other creators and history ============


def test_a_discovered_livestream_is_never_listed_by_the_upload_overlay(home):
    home["events"] = [_event()]
    home["facts"] = {VIDEO: _facts("live", "completed", 7200)}

    for query in (LATEST_VIDEOS, ALL_TAG, SHORT_TAG, LIVE_TAG):
        assert VIDEO not in _ids(**query)


def test_another_creators_discovery_is_not_listed(home):
    home["events"] = [_event("other-video", creator_id=OTHER)]

    assert _ids(**LATEST_VIDEOS) == ["old1"]


def test_a_historical_report_date_is_exactly_as_persisted(home):
    home["events"] = [_event()]

    assert _ids(**LATEST_VIDEOS, reportDate="2026-10-16") == ["old1"]


def test_a_non_dynamodb_deployment_is_untouched(home, monkeypatch):
    home["events"] = [_event()]
    monkeypatch.delenv("YOBI_STORAGE_BACKEND")

    assert _ids(**LATEST_VIDEOS) == ["old1"]


def test_an_unreadable_event_store_leaves_the_persisted_list_as_it_was(home, monkeypatch):
    def broken(event_date, moment):
        raise RuntimeError("table unreachable")

    monkeypatch.setattr(pd, "_events_for_date", broken)

    assert _ids(**LATEST_VIDEOS) == ["old1"]


# ============ the 18:00 run reconciles ============


def test_once_the_daily_ranking_holds_the_video_its_persisted_row_wins_and_no_lookup_is_made(home):
    home["events"] = [_event()]
    home["rows"] = [_persisted(VIDEO, "2026-10-16T09:00:24Z", content_type="upload", title="persisted title"), _persisted("old1", "2026-07-14T10:00:06Z")]

    body = read_api.get_recent_creator_videos(LATEST_VIDEOS)
    row = next(v for v in body["videos"] if v["videoId"] == VIDEO)

    assert [v["videoId"] for v in body["videos"]].count(VIDEO) == 1
    assert "provisional" not in row and row["title"] == "persisted title" and row["currentViewCount"] == 10
    assert home["asked"] == []


def test_the_daily_run_reclassifying_a_provisional_upload_as_live_removes_it_from_the_upload_shelf(home):
    home["events"] = [_event()]
    home["facts"] = {VIDEO: _facts("upload", None, 177)}
    assert VIDEO in _ids(**LATEST_VIDEOS)

    home["rows"] = [_persisted(VIDEO, "2026-10-16T09:00:24Z", content_type="live"), _persisted("old1", "2026-07-14T10:00:06Z")]

    assert VIDEO not in _ids(**LATEST_VIDEOS)  # the persisted classification is authoritative from the moment it exists


# ============ cost and caching ============


def test_several_discoveries_cost_one_batched_lookup_and_a_repeat_request_costs_none(home):
    home["events"] = [_event("v1"), _event("v2"), _event("v3", content_type="short")]
    home["facts"] = {"v1": _facts(), "v2": _facts(duration=30)}

    first = _ids(**ALL_TAG)
    second = _ids(**ALL_TAG)

    assert home["asked"] == [["v1", "v2"]]  # one batch, the Shorts-shelf video is never asked about
    assert first == second and "v1" in first and "v2" not in first and "v3" not in first


def test_a_failed_lookup_is_not_retried_on_every_request(home):
    home["events"] = [_event()]
    home["fail_lookup"] = True

    _ids(**LATEST_VIDEOS)
    _ids(**LATEST_VIDEOS)

    assert len(home["asked"]) == 1


# ============ event date window ============


def test_event_dates_run_from_the_rankings_own_jst_date_through_today_and_are_bounded():
    assert pd._event_dates(GENERATED_AT, "2026-10-17") == ["2026-10-16", "2026-10-17"]
    assert pd._event_dates("2026-10-16T09:02:08+00:00", "2026-10-16") == ["2026-10-16"]  # 18:02 JST is still the 16th in JST
    assert pd._event_dates(GENERATED_AT, "2026-10-30") == ["2026-10-28", "2026-10-29", "2026-10-30"]
    assert pd._event_dates("garbage", "2026-10-17") == ["2026-10-16", "2026-10-17"]


def test_provisional_rows_use_the_injected_clock_for_the_jst_day(home, monkeypatch):
    seen: list[list[str]] = []
    monkeypatch.setattr(pd, "_events_for_date", lambda event_date, moment: seen.append([event_date]) or [])

    pd.with_provisional_discoveries([], CREATOR, GENERATED_AT, now=datetime(2026, 10, 17, 3, 0, tzinfo=timezone.utc))

    assert seen == [["2026-10-16"], ["2026-10-17"]]


# ============ the YouTube lookup itself ============


@pytest.mark.parametrize(
    ("value", "seconds"),
    [("PT3M57S", 237), ("PT45S", 45), ("PT1H", 3600), ("PT1H2M3S", 3723), ("P1DT1S", 86401), ("P0D", 0), (None, None), ("", None), ("P", None), ("PT", None), ("P1DT", None), ("3:57", None), (237, None)],
)
def test_iso8601_duration_parsing(value, seconds):
    assert youtube_client.parse_iso8601_duration_seconds(value) == seconds


class _FakeYouTube:
    """A videos().list(...).execute() answering a fixed response."""

    def __init__(self, items):
        self.items = items
        self.calls = []

    def videos(self):
        return self

    def list(self, **kwargs):
        self.calls.append(kwargs)
        return self

    def execute(self):
        return {"items": self.items}


def _item(video_id: str, *, duration: str | None, live: dict | None = None) -> dict:
    item = {"id": video_id, "snippet": {"title": video_id, "publishedAt": "2026-10-16T09:00:24Z"}, "statistics": {"viewCount": "5"}}
    if duration is not None:
        item["contentDetails"] = {"duration": duration}
    if live is not None:
        item["liveStreamingDetails"] = live
    return item


def test_get_video_facts_uses_the_collectors_classifier_plus_the_duration():
    youtube = _FakeYouTube([
        _item("cover", duration="PT2M57S"),
        _item("short", duration="PT45S"),
        _item("stream", duration="PT3H", live={"actualStartTime": "2026-10-16T05:00:00Z", "actualEndTime": "2026-10-16T08:00:00Z"}),
        _item("no-duration", duration=None),
    ])

    facts = youtube_client.get_video_facts(youtube, ["cover", "short", "stream", "no-duration", "gone"])

    assert facts["cover"] == {"contentType": "upload", "liveStatus": None, "durationSeconds": 177}
    assert facts["short"]["durationSeconds"] == 45
    assert facts["stream"] == {"contentType": "live", "liveStatus": "completed", "durationSeconds": 10800}
    assert facts["no-duration"] == {"contentType": "upload", "liveStatus": None, "durationSeconds": None}
    assert "gone" not in facts  # an id YouTube does not return is unknown, never invented
    assert len(youtube.calls) == 1 and youtube.calls[0]["part"] == "snippet,statistics,liveStreamingDetails,contentDetails"
