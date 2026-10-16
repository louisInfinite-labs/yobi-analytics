"""GET /live-streams over the 10-minute SHARED snapshot: one combined Holodex request feeds every visitor, no page view reaches Holodex, the 7-day
lookahead is cut at request time (so a snapshot up to a display interval old never truncates a viewer's last calendar day), and a stream YouTube has
confirmed ended is no longer listed as live.

Same harness as tests/tracking/test_livestream_lifecycle.py: moto DynamoDB, only api.read_api.holodex_get (the HTTP boundary) mocked and counted.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from api import api_handler, read_api
from tests.tracking.test_livestream_lifecycle import CHANNEL_ID, T0, _holodex_item, dynamo, world  # noqa: F401 -- shared moto fixtures
from tracking import livestream_lifecycle as lifecycle

NOW = T0 + timedelta(minutes=1)


def _freeze(monkeypatch, moment: datetime) -> None:
    """Pin "now" for both the API and the lifecycle's own freshness check, so a snapshot written at T0 is judged at `moment`."""

    class _Frozen(datetime):
        """A datetime whose now() is the pinned instant (every other classmethod keeps working)."""

        @classmethod
        def now(cls, tz=None):
            """The pinned instant."""
            return moment

    monkeypatch.setattr(read_api, "datetime", _Frozen)
    monkeypatch.setattr(lifecycle, "datetime", _Frozen)


def _serve_setup(world, monkeypatch) -> None:
    """The production-shaped read path: DynamoDB backend, no live YouTube classification of upcoming streams."""
    monkeypatch.setenv("YOBI_STORAGE_BACKEND", "dynamodb")
    monkeypatch.setattr(read_api, "classify_unclassified_upcoming", lambda ids: {})


def _ids(body) -> set[str]:
    """The videoIds of a GET /live-streams body."""
    return {stream["videoId"] for stream in body["streams"]}


def _iso(moment: datetime) -> str:
    """Holodex's own timestamp shape."""
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


# ============ one combined request; every visitor shares the snapshot ============


def test_one_users_live_request_returns_live_and_upcoming_together_with_identity_and_schedule_preserved(world, monkeypatch):
    """LIVE and Upcoming come from ONE /users/live request for all channels -- never a second request for the other status."""
    _serve_setup(world, monkeypatch)
    seen: list[tuple[str, dict | None]] = []
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: (seen.append((path, params)), world._holodex_get(path, params))[1])
    world.items = [
        _holodex_item(video_id="live1", status="live"),
        _holodex_item(video_id="soon1", status="upcoming", start_scheduled="2026-10-16T01:00:00Z"),
    ]
    _freeze(monkeypatch, NOW)

    lifecycle.refresh_display_snapshot(now=T0)
    body = read_api.get_live_streams()

    assert len(seen) == 1 and seen[0][0] == "/users/live"  # one request for both statuses
    assert CHANNEL_ID in seen[0][1]["channels"]  # scoped to the tracked channels, not platform-wide
    by_id = {stream["videoId"]: stream for stream in body["streams"]}
    assert by_id["live1"]["status"] == "live" and by_id["live1"]["actualStart"].startswith("2026-10-15T10:00:00")
    assert by_id["soon1"]["status"] == "upcoming" and by_id["soon1"]["scheduledStart"].startswith("2026-10-16T01:00:00")
    assert {stream["creatorId"] for stream in body["streams"]} == {"aizawa_ema"}
    assert all(stream["channelName"] and "title" in stream and "topic" in stream for stream in body["streams"])


def test_every_visitor_reads_the_same_snapshot_and_no_page_view_reaches_holodex(world, monkeypatch):
    """100 visitors opening Home/Schedule (their GET /live-streams) through the real handler cost zero upstream requests beyond the refresh job's."""
    _serve_setup(world, monkeypatch)
    world.items = [_holodex_item(video_id="live1", status="live"), _holodex_item(video_id="soon1", status="upcoming")]
    _freeze(monkeypatch, NOW)
    lifecycle.refresh_display_snapshot(now=T0)
    assert world.holodex_calls == 1

    responses = [api_handler.lambda_handler({"routeKey": "GET /live-streams"}, None) for _ in range(100)]

    assert {response["statusCode"] for response in responses} == {200}
    bodies = {response["body"] for response in responses}
    assert len(bodies) == 1  # one shared answer
    assert {stream["videoId"] for stream in json.loads(bodies.pop())["streams"]} == {"live1", "soon1"}
    assert world.holodex_calls == 1  # not one more request, for any visitor


def test_a_refresh_or_reload_of_the_page_never_makes_the_reader_poll_holodex_even_when_the_snapshot_is_one_missed_run_old(world, monkeypatch):
    """Late (a whole display run missed) is still served from the store -- the reader never turns lateness into an upstream request."""
    _serve_setup(world, monkeypatch)
    world.items = [_holodex_item(video_id="live1", status="live")]
    lifecycle.refresh_display_snapshot(now=T0)
    _freeze(monkeypatch, T0 + timedelta(seconds=lifecycle.DISPLAY_FRESH_SECONDS))

    for _ in range(20):
        assert _ids(read_api.get_live_streams()) == {"live1"}

    assert world.holodex_calls == 1


# ============ the lookahead is cut at request time ============


def test_the_lookahead_is_cut_at_request_time_so_an_older_snapshot_never_truncates_the_last_displayed_day(world, monkeypatch):
    """A viewer whose local midnight passed after the fetch shows streams up to `now + 7 days`, which is beyond `fetch time + 7 days`. The snapshot
    keeps them (a small storage buffer) and the API releases each one the moment it enters the viewer-relative window."""
    _serve_setup(world, monkeypatch)
    fetch = T0
    world.items = [
        _holodex_item(video_id="inside", status="upcoming", start_scheduled=_iso(fetch + timedelta(hours=167))),
        _holodex_item(video_id="edge", status="upcoming", start_scheduled=_iso(fetch + timedelta(hours=168, minutes=20))),
        _holodex_item(video_id="far", status="upcoming", start_scheduled=_iso(fetch + timedelta(hours=170))),
    ]
    _freeze(monkeypatch, fetch)
    lifecycle.refresh_display_snapshot(now=fetch)

    assert {stream["videoId"] for stream in lifecycle.read_serving_snapshot(now=fetch)} == {"inside", "edge"}  # stored: window + buffer, not beyond
    _freeze(monkeypatch, fetch + timedelta(minutes=5))
    assert _ids(read_api.get_live_streams()) == {"inside"}  # `edge` is beyond now + 7 days: not served yet
    _freeze(monkeypatch, fetch + timedelta(minutes=25))  # a still-served snapshot (< MAX_SNAPSHOT_AGE_SECONDS) 25 minutes old
    assert _ids(read_api.get_live_streams()) == {"inside", "edge"}  # the SAME snapshot now serves it -- no new Holodex request needed
    assert world.holodex_calls == 1


def test_the_storage_buffer_covers_the_oldest_snapshot_the_api_will_ever_serve():
    """Otherwise a max-age snapshot would be missing streams that are inside the viewer's window."""
    assert read_api._LOOKAHEAD_STORAGE_BUFFER.total_seconds() >= lifecycle.MAX_SNAPSHOT_AGE_SECONDS


def test_a_live_stream_is_always_kept_whatever_its_scheduled_start(world, monkeypatch):
    """Already happening: neither the storage cut nor the request-time cut applies to it."""
    _serve_setup(world, monkeypatch)
    world.items = [_holodex_item(video_id="old_live", status="live", start_scheduled="2026-08-01T00:00:00Z")]
    _freeze(monkeypatch, NOW)
    lifecycle.refresh_display_snapshot(now=T0)

    assert _ids(read_api.get_live_streams()) == {"old_live"}


# ============ a confirmed end is no longer listed as live ============


def _record_ended(*entries: tuple[str, str]) -> None:
    """Persist ended records: (videoId, endState)."""
    ended = {
        video_id: lifecycle._ended_entry(
            {"videoId": video_id, "creatorId": "aizawa_ema", "title": "t", "scheduledStart": None, "actualStart": None},
            end_state=end_state, previous_refreshed_at=None, moment=T0, actual_end="2026-10-15T12:30:00Z" if end_state == "ended" else None,
        )
        for video_id, end_state in entries
    }
    lifecycle._put_record(lifecycle.ENDED_STREAMS_KEY, {"ended": ended}, T0)
    lifecycle.reset_ended_cache()


def test_a_stream_youtube_confirmed_ended_is_not_listed_as_live_even_while_the_snapshot_still_says_live(world, monkeypatch):
    """The record and the list must agree: this is what lets the Schedule release an overnight hold within one completion interval of the end."""
    _serve_setup(world, monkeypatch)
    monkeypatch.setattr(lifecycle, "ENDED_CACHE_SECONDS", 0)
    world.items = [
        _holodex_item(video_id="ended_live", status="live"),
        _holodex_item(video_id="gone_live", status="live"),
        _holodex_item(video_id="still_live", status="live"),
        _holodex_item(video_id="ended_but_upcoming", status="upcoming"),
    ]
    _freeze(monkeypatch, NOW)
    lifecycle.refresh_display_snapshot(now=T0)
    _record_ended(("ended_live", "ended"), ("gone_live", "unavailable"), ("ended_but_upcoming", "ended"))

    body = read_api.get_live_streams()

    assert _ids(body) == {"gone_live", "still_live", "ended_but_upcoming"}  # only an "ended" LIVE listing is dropped
    assert {entry["videoId"] for entry in body["recentlyEnded"]} == {"ended_live", "gone_live", "ended_but_upcoming"}  # the signal itself is untouched


def test_without_an_end_signal_nothing_is_filtered_and_the_field_stays_absent(world, monkeypatch):
    """No ended record ever written (the feature not run yet, an older deployment): unknown is not 'nothing ended' and not 'everything ended'."""
    _serve_setup(world, monkeypatch)
    world.items = [_holodex_item(video_id="live1", status="live")]
    _freeze(monkeypatch, NOW)
    lifecycle.refresh_display_snapshot(now=T0)

    body = read_api.get_live_streams()

    assert _ids(body) == {"live1"} and "recentlyEnded" not in body


def test_the_filter_helper_ignores_a_missing_or_empty_signal():
    """Pure function edge cases."""
    streams = [{"videoId": "a", "status": "live"}]
    assert read_api._without_confirmed_ended_live_streams(streams, None) is streams
    assert read_api._without_confirmed_ended_live_streams(streams, []) is streams
    assert read_api._without_confirmed_ended_live_streams(streams, [{"videoId": "a", "endState": "unavailable"}]) == streams
    assert read_api._without_confirmed_ended_live_streams(streams, [{"endState": "ended"}]) == streams  # malformed entry: no videoId
