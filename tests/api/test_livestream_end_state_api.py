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

    class _PinnedClock(datetime):
        """A datetime whose now() is the tests' own NOW: the seeded ended records are stamped at NOW, and read_recently_ended only exposes the last 24 h
        of the REAL clock otherwise -- these tests would silently start failing one day after NOW (they did, at 2026-10-17 03:00 UTC)."""

        @classmethod
        def now(cls, tz=None):
            """The pinned instant."""
            return NOW + timedelta(minutes=1)

    monkeypatch.setattr(lifecycle, "datetime", _PinnedClock)


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


# ============ the archive overlay never forces a completed Premiere to contentType="live" ============


def _premiere_archive(**overrides) -> dict:
    """A verified-available archive whose own facts (carried from collection.youtube_client.get_archive_probe, no extra request) show a
    completed Premiere: actualStartTime sits right at publishedAt, inside is_completed_premiere's own window."""
    archive = {
        "status": "available", "attempts": 1, "title": "Premiere Archive", "channelId": f"UC_{CREATOR}",
        "actualStartTime": "2026-10-15T17:00:00Z", "actualEndTime": "2026-10-15T18:00:00Z", "publishedAt": "2026-10-15T17:00:00Z", "viewCount": 321,
    }
    archive.update(overrides)
    return archive


def test_a_newly_discovered_premiere_archive_is_added_as_upload_never_as_a_livestream(dynamo, monkeypatch):
    """No catalog row at all yet (not in the last daily ranking) -- the append path must not default to contentType="live"."""
    _wire(monkeypatch, [_row("old", "2026-10-10T00:00:00Z")])
    _seed(_ended("e1", archive=_premiere_archive()))

    [video] = [video for video in read_api.get_recent_creator_videos({**HOME, "contentType": "upload", "liveStatus": "all"})["videos"] if video["videoId"] == "e1"]

    assert video["contentType"] == "upload" and video.get("liveStatus") is None and video["provisional"] is True
    assert _ids() == ["old"]  # 最新直播 (contentType=live) never lists it


def test_a_stale_catalog_row_still_marked_live_is_corrected_to_upload_when_the_archive_proves_a_premiere(dynamo, monkeypatch):
    """The catalog row predates completion and still says contentType="live" (inherited from how Holodex listed it while upcoming) -- the
    overlay must not keep that label once the verified archive proves it was a Premiere."""
    _wire(monkeypatch, [_row("e1", "2026-10-15T17:00:00Z", live_status="live", views=777, title="From the catalog")])
    _seed(_ended("e1", archive=_premiere_archive()))

    [video] = [v for v in read_api.get_recent_creator_videos({**HOME, "contentType": "upload", "liveStatus": "all"})["videos"] if v["videoId"] == "e1"]

    assert video["contentType"] == "upload" and video.get("liveStatus") is None and video["provisional"] is True
    assert video["title"] == "From the catalog"  # every other catalog field is still preserved
    assert _ids() == []  # never shown under 最新直播


def test_an_unclassified_catalog_row_proven_a_premiere_by_the_archive_is_not_guessed_live(dynamo, monkeypatch):
    """A catalog row with no classification yet (contentType None) -- the overlay's default must not be "live" when the archive says Premiere."""
    _wire(monkeypatch, [{**_row("e1", "2026-10-15T17:00:00Z"), "contentType": None, "liveStatus": None}])
    _seed(_ended("e1", archive=_premiere_archive()))

    assert _ids() == []
    assert _ids(contentType="upload", liveStatus="all") == ["e1"]


def test_an_ordinary_livestream_archive_is_unaffected_by_the_premiere_check(dynamo, monkeypatch):
    """Regression: an ordinary completed livestream (no actualStartTime/publishedAt Premiere shape) keeps contentType="live"/"completed"."""
    _wire(monkeypatch, [_row("old", "2026-10-10T00:00:00Z")])
    _seed(_ended("e1"))  # the module default archive carries no actualStartTime at all

    [video] = [v for v in read_api.get_recent_creator_videos({**HOME})["videos"] if v["videoId"] == "e1"]

    assert video["contentType"] == "live" and video["liveStatus"] == "completed"


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

# ============ the overlay's own rows carry the ORIGINAL discovery time (so a just-ended stream can be NEW) ============


class _Record:
    """The one Video Master field this overlay reads."""

    def __init__(self, discovered_at):
        self.discovered_at = discovered_at


def _video_master_has(monkeypatch, records: dict) -> None:
    """Serve the given videoId -> record map as Video Master (tests/conftest.py stubs the overlay's record read to {} by default)."""
    from api import provisional_discoveries

    monkeypatch.setattr(provisional_discoveries, "_records_for", lambda video_ids, moment: {video_id: records[video_id] for video_id in video_ids if video_id in records})


def test_an_added_archive_row_takes_its_original_discovery_time_from_video_master_never_publishedat(dynamo, monkeypatch):
    """An added archive row takes its original discovery time from Video Master never publishedAt."""
    _wire(monkeypatch, [])
    _seed(_ended("e1"))
    _video_master_has(monkeypatch, {"e1": _Record("2026-10-15T20:30:00+09:00")})

    [video] = read_api.get_recent_creator_videos({**HOME})["videos"]

    assert video["discoveredAt"] == "2026-10-15T20:30:00+09:00" and video["publishedAt"] == "2026-10-15T17:00:00Z"


def test_an_added_archive_row_with_no_recorded_discovery_time_stays_unknown(dynamo, monkeypatch):
    """An added archive row with no recorded discovery time stays unknown (None), not publishedAt."""
    _wire(monkeypatch, [])
    _seed(_ended("e1"), _ended("e2"))
    _video_master_has(monkeypatch, {"e2": _Record(None)})  # e1 has no record at all, e2 has one without a time

    videos = {video["videoId"]: video for video in read_api.get_recent_creator_videos({**HOME})["videos"]}

    assert videos["e1"]["discoveredAt"] is None and videos["e2"]["discoveredAt"] is None


def test_a_just_ended_stream_is_counted_as_new_once_through_its_discovery_time(dynamo, monkeypatch):
    """A just ended stream is counted as new once through its discovery time (a livestream, exactly once)."""
    _wire(monkeypatch, [])
    _seed(_ended("e1"))
    _video_master_has(monkeypatch, {"e1": _Record("2026-10-15T20:30:00+09:00")})

    response = read_api.get_recent_creator_videos({**HOME, "newSince": "2026-10-15T00:00:00Z"}, now=NOW)

    assert response["newContent"]["counts"] == {"videos": 0, "livestreams": 1, "unclassified": 0}
    assert response["newContent"]["livestreamIds"] == "e1"


# ============ a completed Premiere carries its archive-availability time, and that time decides NEW eligibility ============

AVAILABLE_AT = "2026-10-15T11:00:00+00:00"  # 20:00 JST: the lifecycle verified the Premiere's archive available


def _new_since(since: str, **query) -> dict:
    """The recent-videos response for the Premiere's own view (uploads), asked with a first-use baseline."""
    return read_api.get_recent_creator_videos({**HOME, "contentType": "upload", "liveStatus": "all", "newSince": since, **query}, now=NOW)


def test_a_completed_premiere_row_carries_the_lifecycles_archive_availability_time(dynamo, monkeypatch):
    """The overlay hands the lifecycle's own persisted `availableAt` to the row: never a request-time guess."""
    _wire(monkeypatch, [])
    _seed(_ended("e1", archive=_premiere_archive(availableAt=AVAILABLE_AT)))

    [video] = [v for v in read_api.get_recent_creator_videos({**HOME, "contentType": "upload", "liveStatus": "all"})["videos"] if v["videoId"] == "e1"]

    assert video["archiveAvailableAt"] == AVAILABLE_AT


def test_a_stale_catalog_row_corrected_to_upload_also_gets_the_availability_time(dynamo, monkeypatch):
    """The patched catalog row keeps every other field and gains the availability time."""
    _wire(monkeypatch, [_row("e1", "2026-10-15T17:00:00Z", live_status="live", views=777, title="From the catalog")])
    _seed(_ended("e1", archive=_premiere_archive(availableAt=AVAILABLE_AT)))

    [video] = [v for v in read_api.get_recent_creator_videos({**HOME, "contentType": "upload", "liveStatus": "all"})["videos"] if v["videoId"] == "e1"]

    assert video["archiveAvailableAt"] == AVAILABLE_AT and video["title"] == "From the catalog"


def test_a_settled_upload_row_only_gains_the_availability_time_and_nothing_else_changes(dynamo, monkeypatch):
    """Once the daily run classified the Premiere as an upload the overlay used to leave the row alone; the availability time is still attached, and the
    row is not marked provisional."""
    _wire(monkeypatch, [_row("e1", "2026-10-15T17:00:00Z", content_type="upload", live_status=None, views=5, title="Settled")])
    _seed(_ended("e1", archive=_premiere_archive(availableAt=AVAILABLE_AT)))

    [video] = [v for v in read_api.get_recent_creator_videos({**HOME, "contentType": "upload", "liveStatus": "all"})["videos"] if v["videoId"] == "e1"]

    assert video["archiveAvailableAt"] == AVAILABLE_AT
    assert video["title"] == "Settled" and video["currentViewCount"] == 5 and "provisional" not in video


def test_an_ordinary_livestream_archive_and_an_invalid_time_never_carry_an_availability_time(dynamo, monkeypatch):
    """Only a completed Premiere gets the field; an unusable `availableAt` is dropped, never repaired."""
    _wire(monkeypatch, [])
    _seed(_ended("live1", archive={"status": "available", "attempts": 1, "title": "Stream", "publishedAt": "2026-10-15T17:00:00Z", "availableAt": AVAILABLE_AT}), _ended("p1", archive=_premiere_archive(availableAt="not a time")))

    videos = {v["videoId"]: v for v in read_api.get_recent_creator_videos({**HOME, "contentType": "all", "liveStatus": "all"})["videos"]}

    assert "archiveAvailableAt" not in videos["live1"] and "archiveAvailableAt" not in videos["p1"]


def test_first_visit_before_the_archive_still_counts_the_replay_as_new_once_it_is_available(dynamo, monkeypatch):
    """18:50 JST first visit (the baseline), the Premiere was announced earlier (discovered before the baseline), the archive turned available at 20:00 JST:
    the replay is NEW, as one unclassified-free video, exactly once."""
    _wire(monkeypatch, [])
    _seed(_ended("e1", archive=_premiere_archive(availableAt=AVAILABLE_AT)))
    _video_master_has(monkeypatch, {"e1": _Record("2026-10-15T08:00:00+00:00")})  # announced at 17:00 JST, before the 18:50 JST baseline

    content = _new_since("2026-10-15T09:50:00Z")["newContent"]

    assert content["counts"] == {"videos": 1, "livestreams": 0, "unclassified": 0}
    assert content["videoIds"] == "e1"


def test_without_the_availability_time_the_discovery_time_still_decides_exactly_as_before(dynamo, monkeypatch):
    """Ordinary videos keep the first-use baseline semantics: discovered before the baseline means not NEW."""
    _wire(monkeypatch, [])
    _seed(_ended("e1", archive=_premiere_archive()))  # no availableAt recorded
    _video_master_has(monkeypatch, {"e1": _Record("2026-10-15T08:00:00+00:00")})

    assert _new_since("2026-10-15T09:50:00Z")["newContent"]["counts"] == {"videos": 0, "livestreams": 0, "unclassified": 0}


# ============ the durable availability time keeps a replay NEW-eligible after the lifecycle's own record has expired ============


def _record_durable_time(video_id: str, available_at: str) -> None:
    """Put one completed Premiere's availability time on the durable record, as the lifecycle does at confirmation."""
    from stores.premiere_archive_times_store import record_premiere_archive_times

    record_premiere_archive_times({video_id: available_at}, now=NOW)
    read_api.clear_premiere_archive_times_cache()


def _settled_premiere_row(video_id: str = "e1", discovered: str = "2026-10-15T08:00:00+00:00") -> dict:
    """A settled catalog row of a completed Premiere (classified upload by the daily run), announced long before its replay."""
    return {**_row(video_id, "2026-10-15T17:00:00Z", content_type="upload", live_status=None, title="Premiere replay"), "discoveredAt": discovered}


def test_a_settled_premiere_row_gets_its_availability_time_from_the_durable_record_with_no_lifecycle_record_left(dynamo, monkeypatch):
    """The lifecycle ended record has expired (nothing is seeded): the time still reaches the normal recent-videos API row, with nothing else changed."""
    _wire(monkeypatch, [_settled_premiere_row()])
    _seed()  # an empty ended record: the 36-hour retention has pruned the stream
    _record_durable_time("e1", AVAILABLE_AT)

    [video] = read_api.get_recent_creator_videos({**HOME, "contentType": "upload", "liveStatus": "all"})["videos"]

    assert video["archiveAvailableAt"] == AVAILABLE_AT
    assert video["videoId"] == "e1" and video["title"] == "Premiere replay" and video["discoveredAt"] == "2026-10-15T08:00:00+00:00" and "provisional" not in video


def test_returning_more_than_36_hours_later_the_unwatched_replay_is_still_counted_as_new(dynamo, monkeypatch):
    """First visit 18:50 JST (the baseline) while the Premiere was announced earlier, replay available at 20:00 JST -- and the viewer comes back days later,
    long after the lifecycle record expired: the replay is still NEW-eligible, exactly once."""
    _wire(monkeypatch, [_settled_premiere_row()])
    _seed()
    _record_durable_time("e1", AVAILABLE_AT)

    content = _new_since("2026-10-15T09:50:00Z")["newContent"]

    assert content["counts"] == {"videos": 1, "livestreams": 0, "unclassified": 0}
    assert content["videoIds"] == "e1"


def test_a_premiere_that_was_never_confirmed_available_keeps_the_baseline_rule(dynamo, monkeypatch):
    """No durable time (announced, upcoming or pending): the discovery time before the baseline means not NEW, exactly as for any ordinary video."""
    _wire(monkeypatch, [_settled_premiere_row()])
    _seed()

    assert _new_since("2026-10-15T09:50:00Z")["newContent"]["counts"] == {"videos": 0, "livestreams": 0, "unclassified": 0}


def test_an_ordinary_video_is_untouched_by_the_durable_record(dynamo, monkeypatch):
    """Only the exact recorded videoId gets a time; every other row keeps its first-use baseline behavior."""
    _wire(monkeypatch, [_settled_premiere_row(), _settled_premiere_row("ordinary", discovered="2026-10-15T08:00:00+00:00")])
    _seed()
    _record_durable_time("e1", AVAILABLE_AT)

    response = _new_since("2026-10-15T09:50:00Z")
    videos = {video["videoId"]: video for video in response["videos"]}

    assert "archiveAvailableAt" not in videos["ordinary"] and videos["e1"]["archiveAvailableAt"] == AVAILABLE_AT
    assert response["newContent"]["videoIds"] == "e1"


def test_the_lifecycle_time_and_the_durable_time_never_double_count_one_video(dynamo, monkeypatch):
    """While both sources exist for the same videoId the row carries one time (the lifecycle overlay's) and the video is counted once."""
    _wire(monkeypatch, [])
    _seed(_ended("e1", archive=_premiere_archive(availableAt=AVAILABLE_AT)))
    _video_master_has(monkeypatch, {"e1": _Record("2026-10-15T08:00:00+00:00")})
    _record_durable_time("e1", "2026-10-15T11:00:00+00:00")

    response = _new_since("2026-10-15T09:50:00Z")

    assert [video["videoId"] for video in response["videos"]] == ["e1"]
    assert response["videos"][0]["archiveAvailableAt"] == AVAILABLE_AT
    assert response["newContent"]["counts"]["videos"] == 1


def test_an_unreadable_durable_record_never_fails_home(dynamo, monkeypatch):
    """A failed read serves the list without any availability time instead of an error."""
    _wire(monkeypatch, [_settled_premiere_row()])
    _seed()
    monkeypatch.setattr("stores.premiere_archive_times_store.read_premiere_archive_times", lambda: (_ for _ in ()).throw(RuntimeError("table down")))

    [video] = read_api.get_recent_creator_videos({**HOME, "contentType": "upload", "liveStatus": "all"})["videos"]

    assert video["videoId"] == "e1" and "archiveAvailableAt" not in video


def test_the_durable_record_is_read_once_per_cache_window_not_once_per_request(dynamo, monkeypatch):
    """Cost: repeated page requests on a warm Lambda reuse the cached record (one GetItem per window), and a non-DynamoDB backend never reads it."""
    _wire(monkeypatch, [_settled_premiere_row()])
    _seed()
    reads = []
    monkeypatch.setattr("stores.premiere_archive_times_store.read_premiere_archive_times", lambda: reads.append(1) or {"e1": AVAILABLE_AT})

    for _ in range(5):
        read_api.get_recent_creator_videos({**HOME, "contentType": "upload", "liveStatus": "all"})
    assert len(reads) == 1

    monkeypatch.setenv("YOBI_STORAGE_BACKEND", "json")
    read_api.clear_premiere_archive_times_cache()
    read_api.get_recent_creator_videos({**HOME, "contentType": "upload", "liveStatus": "all"})
    assert len(reads) == 1
