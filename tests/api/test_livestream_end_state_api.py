"""The ended-stream records as the API serves them: `recentlyEnded` on GET /live-streams, and Home's 最新直播 (GET /creators/{id}/videos/recent).

Home's list normally only changes when the daily 18:00 JST ranking run writes the S3 result. These tests pin the overlay that lets a livestream whose
archive the lifecycle has VERIFIED appear right after it ends -- by exact videoId, through the endpoint's normal filters, sorting and pagination --
and everything it must NOT do (unverified archives, other creators, historical report dates, rewriting rows that are already right).
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from api import read_api
from tests.tracking.test_livestream_lifecycle import dynamo  # noqa: F401 -- shared moto fixture
from tracking import livestream_lifecycle as lifecycle
from tracking.creator_master import Creator
from tracking.video_topics import classify_video_topic

CREATOR = "aizawa_ema"
OTHER = "usada_pekora"
NOW = datetime(2026, 10, 16, 3, 0, 0, tzinfo=timezone.utc)
HOME = {"creatorId": CREATOR, "contentType": "live", "liveStatus": "archived", "topic": "all", "sort": "newest", "limit": "20", "offset": "0"}


def _creator(creator_id: str) -> Creator:
    """Creator."""
    return Creator(
        creator_id=creator_id, display_name=creator_id, organization="vspo", youtube_channel_id=f"UC_{creator_id}", active=True,
        branch="vspo_jp", group_key=["1期生"], channel_type="member", lifecycle_stage="active", display_order=0,
    )


def _row(video_id: str, published: str, *, content_type="live", live_status="completed", title=None, creator_id=CREATOR, views=500) -> dict:
    """Row."""
    title = title or f"title {video_id}"
    return {
        "videoId": video_id, "creatorId": creator_id, "topic": classify_video_topic(title), "contentType": content_type, "liveStatus": live_status,
        "currentViewCount": views, "title": title, "thumbnailUrl": None, "publishedAt": published, "discoveredAt": None,
    }


def _wire(monkeypatch, rows: list[dict]) -> None:
    """Wire."""
    payload = {"schemaVersion": 2, "reportDate": "2026-10-15", "creatorId": CREATOR, "generatedAt": "2026-10-15T18:05:00+09:00", "videos": rows}

    class _Store:
        @classmethod
        def from_environment_or_default(cls, *, s3_client=None):
            """From environment or default."""
            return cls()

        def read_result(self, report_date: date, creator_id: str):
            """Read result."""
            return payload if creator_id == CREATOR else None

    monkeypatch.setattr(read_api, "S3VideoRankingStore", _Store)
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(CREATOR), _creator(OTHER)])
    monkeypatch.setenv("YOBI_STORAGE_BACKEND", "dynamodb")
    monkeypatch.setattr(lifecycle, "ENDED_CACHE_SECONDS", 0)  # always read the record fresh in tests


def _ended(video_id: str, *, creator_id=CREATOR, archive: dict | None = None, end_state="ended", title="Ended Stream", confirmed=NOW) -> dict:
    """Ended."""
    return {
        "videoId": video_id, "creatorId": creator_id, "title": title, "scheduledStart": None, "actualStart": "2026-10-15T18:00:00+00:00",
        "lastSeenLiveAt": "2026-10-16T02:50:00+00:00", "confirmedEndedAt": confirmed.isoformat(),
        "actualEnd": "2026-10-16T02:55:00Z" if end_state == "ended" else None, "endState": end_state,
        "archive": archive if archive is not None else {"status": "available", "attempts": 1, "title": title, "channelId": f"UC_{creator_id}", "publishedAt": "2026-10-15T17:00:00Z", "viewCount": 321},
    }


def _seed(*entries: dict) -> None:
    """Seed."""
    lifecycle._put_record(lifecycle.ENDED_STREAMS_KEY, {"ended": {entry["videoId"]: entry for entry in entries}}, NOW)
    lifecycle.reset_ended_cache()


def _ids(**query) -> list[str]:
    """Ids."""
    return [video["videoId"] for video in read_api.get_recent_creator_videos({**HOME, **query})["videos"]]


# ============ GET /live-streams carries the end state ============


def test_live_streams_adds_recently_ended_in_its_slim_form_when_the_lifecycle_has_recorded_ends(dynamo, monkeypatch):
    """Live streams adds recently ended in its slim form when the lifecycle has recorded ends."""
    _wire(monkeypatch, [])
    monkeypatch.setattr(read_api, "_read_shared_live_snapshot", lambda: [])
    _seed(_ended("e1"))

    body = read_api.get_live_streams()

    assert body["streams"] == []
    [entry] = body["recentlyEnded"]
    assert entry["videoId"] == "e1" and entry["endState"] == "ended" and entry["actualEnd"] == "2026-10-16T02:55:00Z"
    assert entry["archive"] == {"status": "available"}  # the Schedule can ignore it; the facts stay server-side


def test_live_streams_omits_the_field_when_no_end_signal_exists_and_never_fails_because_of_it(dynamo, monkeypatch):
    """Live streams omits the field when no end signal exists and never fails because of it."""
    _wire(monkeypatch, [])
    monkeypatch.setattr(read_api, "_read_shared_live_snapshot", lambda: [])

    assert read_api.get_live_streams() == {"streams": []}  # record never written: "no end signal", not "nothing ended"

    monkeypatch.delenv("YOBI_STORAGE_BACKEND")
    assert "recentlyEnded" not in read_api.get_live_streams()  # non-DynamoDB backend

    monkeypatch.setenv("YOBI_STORAGE_BACKEND", "dynamodb")
    monkeypatch.setattr(lifecycle, "read_recently_ended", lambda: (_ for _ in ()).throw(RuntimeError("store down")))
    assert read_api.get_live_streams() == {"streams": []}  # the live list still answers


# ============ Home 最新直播: a verified archive appears without waiting for the daily run ============


def test_a_verified_just_ended_stream_appears_in_the_latest_live_list_flagged_provisional(dynamo, monkeypatch):
    """A verified just ended stream appears in the latest live list flagged provisional."""
    _wire(monkeypatch, [_row("old", "2026-10-10T00:00:00Z")])
    _seed(_ended("e1", title="【Minecraft】Night build"))

    response = read_api.get_recent_creator_videos({**HOME})

    by_id = {video["videoId"]: video for video in response["videos"]}
    assert list(by_id) == ["e1", "old"]  # newest first by publishedAt
    assert by_id["e1"] == {
        "videoId": "e1", "creatorId": CREATOR, "topic": classify_video_topic("【Minecraft】Night build"), "contentType": "live", "liveStatus": "completed",
        "currentViewCount": 321, "title": "【Minecraft】Night build", "thumbnailUrl": "https://i.ytimg.com/vi/e1/hqdefault.jpg",
        "publishedAt": "2026-10-15T17:00:00Z", "discoveredAt": None, "provisional": True,
    }
    assert "provisional" not in by_id["old"]  # untouched rows look exactly as before


def test_a_hidden_view_count_is_shown_as_zero_not_invented_and_still_flagged_provisional(dynamo, monkeypatch):
    """A hidden view count is shown as zero not invented and still flagged provisional."""
    _wire(monkeypatch, [])
    _seed(_ended("e1", archive={"status": "available", "title": "T", "publishedAt": "2026-10-15T17:00:00Z", "viewCount": None}))

    [video] = read_api.get_recent_creator_videos({**HOME})["videos"]

    assert video["currentViewCount"] == 0 and video["provisional"] is True


@pytest.mark.parametrize(
    "entry",
    [
        _ended("e1", archive={"status": "pending", "attempts": 0}),
        _ended("e1", archive={"status": "handed_off_to_daily_task", "attempts": 3, "reason": "not_public"}),
        _ended("e1", end_state="unavailable", archive={"status": "unavailable"}),
        _ended("e1", creator_id=OTHER),
    ],
)
def test_nothing_unverified_or_belonging_to_another_creator_is_ever_listed(dynamo, monkeypatch, entry):
    """Nothing unverified or belonging to another creator is ever listed."""
    _wire(monkeypatch, [_row("old", "2026-10-10T00:00:00Z")])
    _seed(entry)

    assert _ids() == ["old"]


def test_the_match_is_by_exact_video_id_a_look_alike_title_never_matches(dynamo, monkeypatch):
    """The match is by exact video id a look alike title never matches."""
    _wire(monkeypatch, [_row("same-title-different-id", "2026-10-14T00:00:00Z", title="Ended Stream")])
    _seed(_ended("e1", title="Ended Stream"))

    assert _ids() == ["e1", "same-title-different-id"]  # two videos, never merged by title


def test_a_catalog_row_that_is_stale_live_or_upcoming_is_shown_completed_keeping_its_other_fields(dynamo, monkeypatch):
    """A catalog row that is stale live or upcoming is shown completed keeping its other fields."""
    _wire(monkeypatch, [_row("e1", "2026-10-15T17:00:00Z", live_status="live", views=777, title="From the catalog")])
    _seed(_ended("e1", title="From the lifecycle"))

    [video] = read_api.get_recent_creator_videos({**HOME})["videos"]

    assert video["liveStatus"] == "completed" and video["provisional"] is True
    assert video["title"] == "From the catalog" and video["currentViewCount"] == 777  # nothing else is rewritten


def test_a_row_the_daily_run_already_has_is_not_duplicated_or_touched(dynamo, monkeypatch):
    """A row the daily run already has is not duplicated or touched."""
    _wire(monkeypatch, [_row("e1", "2026-10-15T17:00:00Z", live_status="completed", views=999)])
    _seed(_ended("e1"))

    [video] = read_api.get_recent_creator_videos({**HOME})["videos"]

    assert video["currentViewCount"] == 999 and "provisional" not in video


def test_a_video_the_catalog_classifies_as_an_upload_is_left_alone(dynamo, monkeypatch):
    """A video the catalog classifies as an upload is left alone."""
    _wire(monkeypatch, [_row("e1", "2026-10-15T17:00:00Z", content_type="upload", live_status=None)])
    _seed(_ended("e1"))

    assert _ids() == []  # not a livestream per the catalog: not listed under 最新直播
    assert _ids(contentType="upload", liveStatus="all") == ["e1"]


def test_filters_apply_to_overlaid_rows_exactly_like_any_other_row(dynamo, monkeypatch):
    """Filters apply to overlaid rows exactly like any other row."""
    _wire(monkeypatch, [])
    _seed(_ended("e1", title="【Minecraft】Night build"))
    topic = classify_video_topic("【Minecraft】Night build")

    assert _ids(topic=topic) == ["e1"] and _ids(topic="apex" if topic != "apex" else "chatting") == []
    assert _ids(contentType="live") == ["e1"] and _ids(contentType="upload") == []
    assert _ids(liveStatus="completed") == ["e1"] and _ids(liveStatus="archived") == ["e1"] and _ids(liveStatus="all") == ["e1"]
    assert _ids(liveStatus="live") == [] and _ids(liveStatus="upcoming") == []


def test_sorting_and_pagination_see_the_overlaid_rows_as_part_of_the_catalog(dynamo, monkeypatch):
    """Sorting and pagination see the overlaid rows as part of the catalog."""
    rows = [_row("r1", "2026-10-14T00:00:00Z"), _row("r2", "2026-10-12T00:00:00Z"), _row("r3", "2026-10-10T00:00:00Z")]
    _wire(monkeypatch, rows)
    _seed(_ended("e1", archive={"status": "available", "title": "E", "publishedAt": "2026-10-13T00:00:00Z", "viewCount": 1}))

    assert _ids() == ["r1", "e1", "r2", "r3"]  # slotted by publishedAt, not stuck on top
    assert _ids(sort="oldest") == ["r3", "r2", "e1", "r1"]
    first = read_api.get_recent_creator_videos({**HOME, "limit": "2", "offset": "0"})
    second = read_api.get_recent_creator_videos({**HOME, "limit": "2", "offset": "2"})
    assert [v["videoId"] for v in first["videos"]] == ["r1", "e1"] and first["hasMore"] is True
    assert [v["videoId"] for v in second["videos"]] == ["r2", "r3"] and second["hasMore"] is False


def test_an_explicit_historical_report_date_is_served_exactly_as_persisted(dynamo, monkeypatch):
    """An explicit historical report date is served exactly as persisted."""
    _wire(monkeypatch, [_row("old", "2026-10-10T00:00:00Z")])
    _seed(_ended("e1"))

    assert _ids(reportDate="2026-10-15") == ["old"]


def test_home_still_works_when_the_ended_record_cannot_be_read(dynamo, monkeypatch):
    """Home still works when the ended record cannot be read."""
    _wire(monkeypatch, [_row("old", "2026-10-10T00:00:00Z")])
    monkeypatch.setattr(lifecycle, "read_available_archives", lambda creator_id: (_ for _ in ()).throw(RuntimeError("store down")))

    assert _ids() == ["old"]


def test_the_view_count_ranking_endpoint_and_a_non_dynamodb_backend_are_unaffected(dynamo, monkeypatch):
    """The view count ranking endpoint and a non dynamodb backend are unaffected."""
    _wire(monkeypatch, [_row("old", "2026-10-10T00:00:00Z")])
    _seed(_ended("e1"))

    ranking = read_api.get_video_ranking({"creatorId": CREATOR, "metric": "total", "limit": "20"})
    assert [row["videoId"] for row in ranking["rows"]] == ["old"]  # historical rankings are not touched

    monkeypatch.delenv("YOBI_STORAGE_BACKEND")
    assert _ids() == ["old"]