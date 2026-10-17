"""A video discovered AFTER the last daily ranking run is listed by Home before the next 18:00 JST run -- from what is PERSISTED about it.

The rule pinned here: a video whose persisted contentType is missing, empty or unknown appears in Home ALL ONLY (never 最新影片, 最新直播,
Shorts, 其他 or any topic tag), whatever its duration; a contentType that becomes valid sends it through the filters of that type; the daily
run's own row replaces the provisional one without a duplicate; nothing is persisted and no contentType is invented.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest

from api import provisional_discoveries as pd
from api import read_api
from tracking.creator_master import Creator
from tracking.video_master import Video

# the real function (tests/conftest.py replaces the attribute for every test so nothing can reach DynamoDB)
_REAL_RECORDS_FOR = pd._records_for

CREATOR = "nekomata_okayu"
OTHER = "usada_pekora"
VIDEO = "_wFR042t70Q"  # the 177-second cover whose Video Master record has no contentType
GENERATED_AT = "2026-10-16T18:01:49+09:00"
BASE = {"creatorId": CREATOR, "liveStatus": "archived", "topic": "all", "sort": "newest", "limit": "20", "offset": "0"}
ALL_TAG = {**BASE, "contentType": "all", "excludeShorts": "true"}  # Home ALL
ALL_PLAIN = {**BASE, "contentType": "all"}
LATEST_VIDEOS = {**BASE, "contentType": "upload"}  # 最新影片
LATEST_LIVE = {**BASE, "contentType": "live"}  # 最新直播
SHORT_TAG = {**BASE, "contentType": "short"}


def _creator(creator_id: str) -> Creator:
    """A minimal active member creator."""
    return Creator(
        creator_id=creator_id, display_name=creator_id, organization="hololive", youtube_channel_id=f"UC_{creator_id}", active=True,
        branch="holo_jp", group_key=["ゲーマーズ"], channel_type="member", lifecycle_stage="active", display_order=0,
    )


def _persisted(video_id: str, published: str, *, content_type="upload", topic="other") -> dict:
    """A row as the daily 18:00 run persisted it."""
    return {
        "videoId": video_id, "creatorId": CREATOR, "topic": topic, "contentType": content_type, "liveStatus": None, "currentViewCount": 10,
        "title": f"title {video_id}", "thumbnailUrl": None, "publishedAt": published, "discoveredAt": "2026-07-14T19:00:00+09:00",
    }


def _event(video_id: str = VIDEO, *, creator_id: str = CREATOR, content_type: str | None = None) -> dict:
    """A discovery event as run_discovery records it."""
    event = {
        "eventDate": "2026-10-16", "videoId": video_id, "eventId": f"new_video:{video_id}", "creatorId": creator_id, "title": "モニタリング (cover)",
        "publishedAt": "2026-10-16T09:00:24Z", "discoveredAt": "2026-10-16T20:00:42+09:00", "discoverySource": "discovery_window:2000",
        "notificationEligible": True,
    }
    if content_type:
        event["contentType"] = content_type
    return event


def _record(video_id: str = VIDEO, *, content_type=None, live_status=None, topic="mv") -> Video:
    """The Video Master record discovery persisted (no contentType until the daily run classifies it)."""
    return Video(
        video_id=video_id, creator_id=CREATOR, title="モニタリング (cover)", published_at="2026-10-16T09:00:24Z",
        thumbnail_url=f"https://i.ytimg.com/vi/{video_id}/maxresdefault.jpg", discovered_at="2026-10-16T20:00:42.811856+09:00", topic=topic,
        content_type=content_type, live_status=live_status,
    )


@pytest.fixture
def home(monkeypatch):
    """The persisted ranking, the discovery events and the Video Master records, all in memory; records every Video Master read."""
    state = {"rows": [_persisted("old1", "2026-07-14T10:00:06Z")], "events": [], "records": {}, "reads": [], "records_fail": False}

    class _Store:
        @classmethod
        def from_environment_or_default(cls, *, s3_client=None):
            """From environment or default."""
            return cls()

        def read_result(self, report_date: date, creator_id: str):
            """Read result."""
            return {"schemaVersion": 2, "reportDate": "2026-10-16", "creatorId": creator_id, "generatedAt": GENERATED_AT, "videos": state["rows"]}

    def get_videos(video_ids):
        state["reads"].append(sorted(video_ids))
        if state["records_fail"]:
            raise RuntimeError("table unreachable")
        return {video_id: state["records"][video_id] for video_id in video_ids if video_id in state["records"]}

    monkeypatch.setattr(read_api, "S3VideoRankingStore", _Store)
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(CREATOR), _creator(OTHER)])
    monkeypatch.setattr(read_api, "_read_available_archives", lambda creator_id: [])
    monkeypatch.setenv("YOBI_STORAGE_BACKEND", "dynamodb")
    monkeypatch.setattr(pd, "_events_for_date", lambda event_date, moment: list(state["events"]))
    monkeypatch.setattr(pd, "_records_for", _REAL_RECORDS_FOR)
    monkeypatch.setattr("stores.dynamodb_store.get_videos", get_videos)
    return state


def _ids(**query) -> list[str]:
    """Video ids Home's shelf returns for a query."""
    return [video["videoId"] for video in read_api.get_recent_creator_videos(query)["videos"]]


def _topic_tag(topic: str) -> dict:
    """A topic tag's query: that topic, no Shorts."""
    return {**BASE, "contentType": "all", "topic": topic, "excludeShorts": "true"}


# ============ the specific case: _wFR042t70Q, persisted contentType still empty (177 s) ============


def test_the_video_with_no_persisted_contentType_is_visible_in_home_all_and_nowhere_else(home):
    home["events"] = [_event()]
    home["records"] = {VIDEO: _record()}

    assert VIDEO in _ids(**ALL_TAG)
    assert VIDEO in _ids(**ALL_PLAIN)
    assert VIDEO not in _ids(**LATEST_VIDEOS)  # 最新影片: even though it is 177 s long
    assert VIDEO not in _ids(**LATEST_LIVE)  # 最新直播
    assert VIDEO not in _ids(**SHORT_TAG)  # Shorts
    assert VIDEO not in _ids(**_topic_tag("other"))  # 其他
    assert VIDEO not in _ids(**_topic_tag("mv"))  # not even its own persisted topic: any topic tag
    assert VIDEO not in _ids(**_topic_tag("chatting"))


def test_the_provisional_row_never_invents_a_contentType_and_says_it_is_provisional(home):
    home["events"] = [_event()]
    home["records"] = {VIDEO: _record()}

    [row] = [v for v in read_api.get_recent_creator_videos(ALL_TAG)["videos"] if v["videoId"] == VIDEO]

    assert row["contentType"] is None and row["liveStatus"] is None and row["provisional"] is True
    assert row["publishedAt"] == "2026-10-16T09:00:24Z" and row["discoveredAt"] == "2026-10-16T20:00:42.811856+09:00"
    assert row["thumbnailUrl"] == f"https://i.ytimg.com/vi/{VIDEO}/maxresdefault.jpg" and row["title"] == "モニタリング (cover)"


def test_the_newest_provisional_video_leads_home_all(home):
    home["events"] = [_event()]
    home["records"] = {VIDEO: _record()}

    assert _ids(**ALL_TAG) == [VIDEO, "old1"]


@pytest.mark.parametrize("unknown", [None, "", "ALL", "all", "unknown", "video"])
def test_a_missing_empty_or_unknown_persisted_contentType_is_all_only(home, unknown):
    home["events"] = [_event()]
    home["records"] = {VIDEO: Video(video_id=VIDEO, creator_id=CREATOR, title="t", published_at="2026-10-16T09:00:24Z", content_type=unknown)}

    assert VIDEO in _ids(**ALL_TAG)
    for query in (LATEST_VIDEOS, LATEST_LIVE, SHORT_TAG, _topic_tag("other"), _topic_tag("chatting")):
        assert VIDEO not in _ids(**query)


def test_a_video_with_no_video_master_record_yet_is_listed_from_its_event_in_all_only(home):
    home["events"] = [_event()]  # the record cannot be found

    assert VIDEO in _ids(**ALL_TAG)
    for query in (LATEST_VIDEOS, LATEST_LIVE, SHORT_TAG, _topic_tag("other")):
        assert VIDEO not in _ids(**query)


def test_an_unreadable_video_master_still_lists_the_video_in_all_only(home):
    home["events"] = [_event()]
    home["records_fail"] = True

    assert VIDEO in _ids(**ALL_TAG)
    assert VIDEO not in _ids(**LATEST_VIDEOS) and VIDEO not in _ids(**_topic_tag("other"))


# ============ a valid contentType that becomes available sends it through that type's filters ============


def test_once_the_persisted_contentType_is_upload_it_enters_latest_videos_all_and_its_topic(home):
    home["events"] = [_event()]
    home["records"] = {VIDEO: _record(content_type="upload", topic="mv")}

    assert VIDEO in _ids(**LATEST_VIDEOS)
    assert VIDEO in _ids(**ALL_TAG)
    assert VIDEO in _ids(**_topic_tag("mv"))
    assert VIDEO not in _ids(**_topic_tag("other"))  # only its own topic
    assert VIDEO not in _ids(**SHORT_TAG) and VIDEO not in _ids(**LATEST_LIVE)


def test_a_persisted_short_enters_the_shorts_shelf_only(home):
    home["events"] = [_event()]
    home["records"] = {VIDEO: _record(content_type="short")}

    assert VIDEO in _ids(**SHORT_TAG)
    assert VIDEO not in _ids(**LATEST_VIDEOS) and VIDEO not in _ids(**ALL_TAG) and VIDEO not in _ids(**_topic_tag("mv"))


def test_the_discovery_events_shorts_shelf_flag_is_a_valid_type_even_without_a_record(home):
    home["events"] = [_event(content_type="short")]

    assert VIDEO in _ids(**SHORT_TAG)
    assert VIDEO not in _ids(**LATEST_VIDEOS) and VIDEO not in _ids(**ALL_TAG)


def test_a_persisted_completed_livestream_enters_latest_live_and_a_running_one_stays_out_of_the_archive(home):
    home["events"] = [_event("done"), _event("running")]
    home["records"] = {"done": _record("done", content_type="live", live_status="completed"), "running": _record("running", content_type="live", live_status="live")}

    assert "done" in _ids(**LATEST_LIVE) and "running" not in _ids(**LATEST_LIVE)
    assert "done" not in _ids(**LATEST_VIDEOS) and "done" not in _ids(**SHORT_TAG)


# ============ scope: creator, history, backend, failures ============


def test_another_creators_discovery_is_not_listed(home):
    home["events"] = [_event("other-video", creator_id=OTHER)]

    assert _ids(**ALL_TAG) == ["old1"]


def test_a_historical_report_date_is_exactly_as_persisted(home):
    home["events"] = [_event()]
    home["records"] = {VIDEO: _record()}

    assert _ids(**ALL_TAG, reportDate="2026-10-16") == ["old1"]


def test_a_non_dynamodb_deployment_is_untouched(home, monkeypatch):
    home["events"] = [_event()]
    monkeypatch.delenv("YOBI_STORAGE_BACKEND")

    assert _ids(**ALL_TAG) == ["old1"]


def test_an_unreadable_event_store_leaves_the_persisted_list_as_it_was(home, monkeypatch):
    def broken(event_date, moment):
        raise RuntimeError("table unreachable")

    monkeypatch.setattr(pd, "_events_for_date", broken)

    assert _ids(**ALL_TAG) == ["old1"]


# ============ the 18:00 run reconciles without a duplicate ============


def test_once_the_daily_ranking_holds_the_video_its_persisted_row_wins_and_it_is_listed_once(home):
    home["events"] = [_event()]
    home["records"] = {VIDEO: _record()}
    assert VIDEO not in _ids(**LATEST_VIDEOS)  # still unclassified before the run

    home["rows"] = [_persisted(VIDEO, "2026-10-16T09:00:24Z", content_type="upload", topic="mv"), _persisted("old1", "2026-07-14T10:00:06Z")]
    home["reads"].clear()

    ids = _ids(**ALL_TAG)
    body = read_api.get_recent_creator_videos(LATEST_VIDEOS)
    row = next(v for v in body["videos"] if v["videoId"] == VIDEO)

    assert ids.count(VIDEO) == 1 and [v["videoId"] for v in body["videos"]].count(VIDEO) == 1
    assert "provisional" not in row and row["contentType"] == "upload" and row["currentViewCount"] == 10
    assert home["reads"] == []  # nothing provisional is read for a video the ranking holds


def test_the_daily_run_classifying_the_video_as_a_livestream_removes_it_from_the_upload_shelves(home):
    home["events"] = [_event()]
    home["records"] = {VIDEO: _record()}
    home["rows"] = [_persisted(VIDEO, "2026-10-16T09:00:24Z", content_type="live"), _persisted("old1", "2026-07-14T10:00:06Z")]

    assert VIDEO not in _ids(**LATEST_VIDEOS)


# ============ cost and caching ============


def test_several_discoveries_cost_one_batched_read_and_a_repeat_request_costs_none(home):
    home["events"] = [_event("v1"), _event("v2")]
    home["records"] = {"v1": _record("v1"), "v2": _record("v2", content_type="upload")}

    first = _ids(**ALL_TAG)
    second = _ids(**ALL_TAG)

    assert home["reads"] == [["v1", "v2"]]
    assert first == second and {"v1", "v2"} <= set(first)


# ============ event date window ============


def test_event_dates_run_from_the_rankings_own_jst_date_through_today_and_are_bounded():
    assert pd._event_dates(GENERATED_AT, "2026-10-17") == ["2026-10-16", "2026-10-17"]
    assert pd._event_dates("2026-10-16T09:02:08+00:00", "2026-10-16") == ["2026-10-16"]  # 18:02 JST is still the 16th in JST
    assert pd._event_dates(GENERATED_AT, "2026-10-30") == ["2026-10-28", "2026-10-29", "2026-10-30"]
    assert pd._event_dates("garbage", "2026-10-17") == ["2026-10-16", "2026-10-17"]


def test_provisional_rows_use_the_injected_clock_for_the_jst_day(home, monkeypatch):
    seen: list[str] = []
    monkeypatch.setattr(pd, "_events_for_date", lambda event_date, moment: seen.append(event_date) or [])

    pd.with_provisional_discoveries([], CREATOR, GENERATED_AT, now=datetime(2026, 10, 17, 3, 0, tzinfo=timezone.utc))

    assert seen == ["2026-10-16", "2026-10-17"]


def test_is_unclassified_provisional_is_true_only_for_a_provisional_row_without_a_contentType():
    assert pd.is_unclassified_provisional({"provisional": True, "contentType": None})
    assert pd.is_unclassified_provisional({"provisional": True, "contentType": ""})
    assert pd.is_unclassified_provisional({"provisional": True})
    assert not pd.is_unclassified_provisional({"provisional": True, "contentType": "upload"})
    assert not pd.is_unclassified_provisional({"contentType": None})  # a persisted row with no contentType is not the overlay's business
