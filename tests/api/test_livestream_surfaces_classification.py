"""ONE canonical content classification across the livestream surfaces (Item 3).

Video Master's stored contentType is the single decision: an ordinary upload (which includes an uploaded MV/Cover Premiere) or a
Short is NOT a livestream, so it never appears in GET /live-streams (Home's 最新直播 and the reminder schedule) or GET
/recent-streams (the livestream archive), while a real stream keeps its place; the video shelves use the SAME stored value, so a
Premiere that is a video lands on the video side and nowhere else. Missing classification keeps the stream (fail open).
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from api import read_api
from tracking.creator_master import Creator
from tracking.video_master import Video, is_known_non_livestream

from tests.api.test_cover_mv_premiere_filtering import _item, _iso, _stored_row

CREATOR = "emma"
CHANNEL = "UC_emma"


def _creator() -> Creator:
    return Creator(
        creator_id=CREATOR, display_name="Emma", organization="vspo", youtube_channel_id=CHANNEL, active=True,
        branch="vspo_jp", group_key=["1期生"], channel_type="member", lifecycle_stage="active", display_order=0,
    )


def _holodex(video_id: str, status: str, title: str, *, hours_ahead: float = 3) -> dict:
    start = datetime.now(timezone.utc) + timedelta(hours=hours_ahead)
    return {
        "id": video_id, "status": status, "channel": {"id": CHANNEL, "name": "Emma"}, "title": title,
        "start_scheduled": _iso(start), "start_actual": _iso(datetime.now(timezone.utc) - timedelta(minutes=5)) if status == "live" else None,
    }


def _video(video_id: str, content_type: str | None, live_status: str | None = None) -> Video:
    return Video(
        video_id=video_id, creator_id=CREATOR, title=video_id, published_at="2026-10-01T00:00:00Z",
        content_type=content_type, live_status=live_status,
    )


# What Holodex returns for /users/live: it lists a YouTube Premiere exactly like a stream.
HOLODEX_LIVE = [
    _holodex("true-upcoming", "upcoming", "【雑談】明日の予定"),
    _holodex("true-live", "live", "【VALORANT】ランク"),
    _holodex("cover-premiere", "upcoming", "【Cover】Nostalgia / covered by Emma"),
    _holodex("mv-premiere", "upcoming", "【MV】Original Song"),
    _holodex("singing-live", "live", "【歌枠】のんびり歌う"),
    _holodex("not-yet-observed", "upcoming", "【雑談】新しい配信"),
    _holodex("a-short", "upcoming", "short"),
]
# Video Master after the collector observed them (collection.youtube_client): Premieres that are videos are "upload".
STORED = {
    "true-upcoming": _video("true-upcoming", "live", "upcoming"),
    "true-live": _video("true-live", "live", "live"),
    "cover-premiere": _video("cover-premiere", "upload"),
    "mv-premiere": _video("mv-premiere", "upload"),
    "singing-live": _video("singing-live", "live", "live"),
    "a-short": _video("a-short", "short"),
}


@pytest.fixture
def live(monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: list(HOLODEX_LIVE))
    calls: list[list[str]] = []

    def get_videos(video_ids):
        calls.append(list(video_ids))
        return {video_id: STORED[video_id] for video_id in video_ids if video_id in STORED}

    monkeypatch.setattr(read_api, "get_videos", get_videos)
    return calls


def _live_ids() -> list[str]:
    return [stream["videoId"] for stream in read_api.get_live_streams()["streams"]]


def test_the_single_rule_only_a_positive_upload_or_short_classification_is_not_a_livestream():
    assert is_known_non_livestream("upload") is True
    assert is_known_non_livestream("short") is True
    assert is_known_non_livestream("live") is False
    assert is_known_non_livestream(None) is False  # unclassified: never hides a real stream


# --- GET /live-streams (Home 最新直播 current streams, the reminder schedule) ---


def test_true_upcoming_and_true_live_and_singing_livestreams_stay_in_the_livestream_list(live):
    ids = _live_ids()

    assert {"true-upcoming", "true-live", "singing-live"} <= set(ids)


def test_a_scheduled_cover_premiere_and_a_scheduled_mv_premiere_are_not_livestreams(live):
    ids = _live_ids()

    assert "cover-premiere" not in ids
    assert "mv-premiere" not in ids


def test_a_short_is_never_a_livestream(live):
    assert "a-short" not in _live_ids()


def test_a_stream_nobody_has_classified_yet_is_kept_rather_than_hidden(live):
    assert "not-yet-observed" in _live_ids()


def test_holodexs_own_order_is_preserved_and_the_classification_costs_one_batch_read(live):
    ids = _live_ids()

    assert ids == ["true-upcoming", "true-live", "singing-live", "not-yet-observed"]
    assert len(live) == 1 and set(live[0]) == {item["id"] for item in HOLODEX_LIVE}


def test_a_failed_classification_lookup_never_takes_the_endpoint_down(monkeypatch, live, capsys):
    def boom(video_ids):
        raise RuntimeError("DynamoDB unavailable")

    monkeypatch.setattr(read_api, "get_videos", boom)

    assert _live_ids() == [item["id"] for item in HOLODEX_LIVE]
    assert "classification lookup failed" in capsys.readouterr().out


def test_raw_data_api_items_flow_through_the_one_classifier_into_the_livestream_list(monkeypatch):
    """The same answer end to end: collector classification of real response shapes -> Video Master -> /live-streams."""
    from collection.youtube_client import _parse_video_item

    start = datetime.now(timezone.utc) + timedelta(hours=3)
    upcoming = {"scheduledStartTime": _iso(start)}

    def raw(video_id, title, content_details):
        return {
            "id": video_id,
            "snippet": {"title": title, "publishedAt": "2026-10-08T04:03:21Z", "liveBroadcastContent": "upcoming"},
            "statistics": {"viewCount": "0"},
            "liveStreamingDetails": upcoming,
            "contentDetails": content_details,
        }

    items = [
        raw("cover-premiere", "【Cover】Nostalgia", {"definition": "hd"}),  # upcoming Premiere: no duration
        raw("mv-premiere", "【MV】Original Song", {"definition": "hd"}),
        raw("true-upcoming", "【雑談】明日の予定", {"definition": "hd", "duration": "P0D"}),
        raw("singing-live", "【歌枠】のんびり歌う", {"definition": "hd", "duration": "P0D"}),
    ]
    stored = {}
    for item in items:
        parsed = _parse_video_item(item)
        stored[item["id"]] = _video(item["id"], parsed["contentType"], parsed["liveStatus"])
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_holodex(item["id"], "upcoming", item["snippet"]["title"]) for item in items])
    monkeypatch.setattr(read_api, "get_videos", lambda ids: {i: stored[i] for i in ids if i in stored})

    assert _live_ids() == ["true-upcoming", "singing-live"]
    assert stored["cover-premiere"].content_type == "upload" and stored["mv-premiere"].content_type == "upload"


# --- the transition: an upcoming Premiere that later runs, and a real stream that later runs ---


def _raw(video_id: str, state: str, content_details: dict) -> dict:
    """A real videos.list item for `state` ("upcoming" / "live"): the upcoming Premiere has no duration, the real stream "P0D"."""
    live = {"scheduledStartTime": "2026-10-10T10:00:00Z"}
    if state == "live":
        live["actualStartTime"] = "2026-10-10T10:00:30Z"
    return {
        "id": video_id,
        "snippet": {"title": video_id, "publishedAt": "2026-10-08T04:03:21Z", "liveBroadcastContent": state},
        "statistics": {"viewCount": "0"},
        "liveStreamingDetails": live,
        "contentDetails": content_details,
    }


def test_an_upcoming_premiere_that_starts_running_stays_an_upload_and_never_enters_the_livestream_list(monkeypatch):
    """10:00 upcoming Premiere -> canonical upload; 11:00 it is running (the collector reads it as a running broadcast, Holodex as LIVE)."""
    from collection.youtube_client import _parse_video_item
    from tests.test_history_worker_scheduler_state import _observe, _stored

    upcoming = _parse_video_item(_raw("premiere-1", "upcoming", {"definition": "hd"}))
    assert (upcoming["contentType"], upcoming["liveStatus"]) == ("upload", None)  # 1-2: observed upcoming, classified and stored as upload

    running = _parse_video_item(_raw("premiere-1", "live", {"definition": "hd"}))  # 3: the same video, now running
    assert (running["contentType"], running["liveStatus"]) == ("live", "live")  # what the parser alone can see (nothing verified says otherwise)
    video_master, _manifest = _observe(monkeypatch, _stored(upcoming["contentType"]), (running["contentType"], running["liveStatus"]))
    [after] = video_master.upsert_calls[0]
    assert (after.content_type, after.live_status) == ("upload", None)  # 4: the stored canonical type is unchanged

    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_holodex("premiere-1", "live", "【Cover】Nostalgia"), _holodex("real-1", "live", "【雑談】配信")])
    monkeypatch.setattr(read_api, "get_videos", lambda ids: {"premiere-1": after, "real-1": _video("real-1", "live", "live")}.copy())
    assert _live_ids() == ["real-1"]  # 5-6: not in /live-streams, so not in Latest Live; the real running stream is


def test_a_real_upcoming_stream_that_starts_running_stays_a_livestream(monkeypatch):
    from collection.youtube_client import _parse_video_item
    from tests.test_history_worker_scheduler_state import _observe, _stored

    upcoming = _parse_video_item(_raw("stream-1", "upcoming", {"definition": "hd", "duration": "P0D"}))
    running = _parse_video_item(_raw("stream-1", "live", {"definition": "hd", "duration": "P0D"}))
    assert (upcoming["contentType"], upcoming["liveStatus"]) == ("live", "upcoming")
    video_master, _manifest = _observe(monkeypatch, _stored(upcoming["contentType"], upcoming["liveStatus"]), (running["contentType"], running["liveStatus"]))
    [after] = video_master.upsert_calls[0]
    assert (after.content_type, after.live_status) == ("live", "live")

    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_holodex("stream-1", "live", "【雑談】配信")])
    monkeypatch.setattr(read_api, "get_videos", lambda ids: {"stream-1": after})
    assert _live_ids() == ["stream-1"]


def test_a_video_first_seen_only_while_running_is_kept_as_a_livestream_the_documented_limit(monkeypatch):
    """No verified API signal tells a running Premiere from a running stream, so a video never classified before it started FAILS OPEN."""
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_holodex("first-seen-live", "live", "【Cover】Nostalgia")])
    monkeypatch.setattr(read_api, "get_videos", lambda ids: {})

    assert _live_ids() == ["first-seen-live"]  # never decided from the title either


def test_the_reminder_schedule_is_built_from_the_same_filtered_list(monkeypatch, live):
    from notifications import notification_dispatcher
    from stores import remote_config_store

    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: None)
    written = {}
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: written.update(record))
    monkeypatch.setattr(notification_dispatcher.remote_config_api, "write_remote_config", lambda record: record)

    entries = notification_dispatcher._refresh_and_load_stream_schedule(now=datetime.now(timezone.utc))

    assert "cover-premiere" not in entries and "mv-premiere" not in entries
    assert {"true-upcoming", "true-live"} <= set(entries)


# --- GET /recent-streams (the livestream archive) ---


def test_a_completed_premiere_is_not_in_the_livestream_archive_but_a_completed_true_stream_is(monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    raw = [
        {"id": "true-archive", "channel": {"id": CHANNEL, "name": "Emma"}, "title": "【雑談】おつ", "available_at": "2026-10-02T10:00:00Z"},
        {"id": "cover-premiere-done", "channel": {"id": CHANNEL, "name": "Emma"}, "title": "【Cover】Song", "available_at": "2026-10-01T10:00:00Z"},
    ]
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: list(raw))
    monkeypatch.setattr(
        read_api, "get_videos", lambda ids: {"true-archive": _video("true-archive", "live", "completed"), "cover-premiere-done": _video("cover-premiere-done", "upload")}
    )

    result = read_api.get_recent_streams({"creatorId": CREATOR, "limit": "2"})

    assert [stream["videoId"] for stream in result["streams"]] == ["true-archive"]
    assert result["hasMore"] is True  # still derived from the RAW page, so a dropped Premiere never ends paging early


# --- the video side reads the SAME stored classification ---

REPORT_DATE = "2026-10-01"
BASE = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)


def _row(item: dict) -> dict:
    row = _stored_row(item)
    row["creatorId"] = CREATOR
    return row


@pytest.fixture
def shelves(monkeypatch):
    def archive(video_id: str, title: str, day: int) -> dict:
        start = BASE + timedelta(days=day)
        return _item(video_id, title, start + timedelta(hours=5), {"scheduledStartTime": _iso(start), "actualStartTime": _iso(start), "actualEndTime": _iso(start + timedelta(hours=3))})

    def premiere(video_id: str, title: str, day: int) -> dict:
        start = BASE + timedelta(days=day)
        return _item(video_id, title, start, {"scheduledStartTime": _iso(start), "actualStartTime": _iso(start), "actualEndTime": _iso(start + timedelta(minutes=4))})

    items = [
        _item("mv-upload", "【MV】Original Song", BASE + timedelta(days=4)),
        premiere("cover-premiere-done", "【Cover】Nostalgia / covered by Emma", 5),
        premiere("mv-premiere-done", "【MV】New Song", 6),
        _item("singing-upload", "【歌枠】切り抜き", BASE + timedelta(days=7)),
        archive("singing-livestream", "【歌枠】のんびり歌う", 2),
        archive("true-archive", "【雑談】おつ", 1),
    ]
    payload = {"schemaVersion": 2, "reportDate": REPORT_DATE, "creatorId": CREATOR, "generatedAt": f"{REPORT_DATE}T18:05:00+09:00", "videos": [_row(item) for item in items]}

    class _Store:
        @classmethod
        def from_environment_or_default(cls, *, s3_client=None):
            return cls()

        def read_result(self, report_date: date, creator_id: str):
            return payload if creator_id == CREATOR else None

    monkeypatch.setattr(read_api, "S3VideoRankingStore", _Store)
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])


def _shelf(**query) -> set[str]:
    response = read_api.get_recent_creator_videos({"creatorId": CREATOR, "reportDate": REPORT_DATE, "limit": "20", **query})
    return {video["videoId"] for video in response["videos"]}


def test_latest_videos_has_the_uploaded_mv_the_completed_premieres_and_the_singing_upload_but_no_stream(shelves):
    assert _shelf(topic="all", contentType="upload", liveStatus="archived") == {"mv-upload", "cover-premiere-done", "mv-premiere-done", "singing-upload"}


def test_the_mv_filter_keeps_cover_and_mv_videos_and_no_livestream(shelves):
    assert _shelf(topic="mv", contentType="upload", liveStatus="archived") == {"mv-upload", "cover-premiere-done", "mv-premiere-done"}


def test_latest_live_archive_has_only_real_livestreams_and_no_premiere(shelves):
    archive = _shelf(topic="all", contentType="live", liveStatus="archived")

    assert archive == {"singing-livestream", "true-archive"}
    assert not archive & {"cover-premiere-done", "mv-premiere-done"}


def test_singing_splits_by_what_it_is_a_livestream_or_an_upload(shelves):
    assert _shelf(topic="singing", contentType="live", liveStatus="archived") == {"singing-livestream"}
    assert _shelf(topic="singing", contentType="upload", liveStatus="archived") == {"singing-upload"}


def test_no_video_is_on_both_the_video_side_and_the_livestream_side(shelves):
    assert not _shelf(topic="all", contentType="upload", liveStatus="archived") & _shelf(topic="all", contentType="live", liveStatus="archived")
