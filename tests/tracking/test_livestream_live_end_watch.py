"""Tests for the 10-minute shared snapshot's two compensations in tracking.livestream_lifecycle: the LIVE-END WATCH (a stream YouTube already
reports ended is confirmed by the next 5-minute completion cycle, even while the slower Holodex snapshot still lists it) and the archive lookup
window anchored to the stream's actual END (so confirming an end sooner never shortens the time YouTube gets to finish processing the upload).

Same harness as test_livestream_lifecycle.py: only the Holodex HTTP boundary and the YouTube probe are mocked, every upstream request is counted.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from tests.tracking.test_livestream_lifecycle import T0, World, _holodex_item, _probe, _video, dynamo, world  # noqa: F401 -- shared fixtures
from tracking import livestream_lifecycle as lifecycle


def _on_air(world, *video_ids):
    """Holodex lists each video live and YouTube agrees it is still on air."""
    world.items = [_holodex_item(video_id=video_id, status="live") for video_id in video_ids]
    world.probes = {video_id: _probe(actualEndTime=None) for video_id in video_ids}


# ============ the live-end watch ============


def test_an_end_youtube_already_reports_is_confirmed_by_the_next_cycle_while_holodex_still_lists_the_stream(world):
    """The stream is still in the Holodex snapshot (listed live), YouTube already has its actualEndTime: this cycle records the end."""
    _on_air(world, "v1")
    world.display()
    world.completion()
    world.probes = {"v1": _probe(actualEndTime="2026-10-15T13:01:30Z")}
    world.clock += timedelta(minutes=5)

    summary = world.completion()  # NO display refresh in between: Holodex has not caught up

    assert summary["confirmedCompleted"] == ["v1"] and summary["completionCandidates"] == ["v1"]
    entry = world.ended()["v1"]
    assert entry["endState"] == lifecycle.END_STATE_ENDED
    assert entry["actualEnd"] == "2026-10-15T13:01:30Z"  # YouTube's own value
    assert entry["confirmedEndedAt"] == world.clock.isoformat()
    assert entry["archive"]["status"] == lifecycle.ARCHIVE_AVAILABLE  # the same probe answered the archive lookup
    assert world.holodex_calls == 1  # the confirmation never needed another Holodex request


def test_the_end_is_confirmed_within_one_completion_interval_of_youtubes_actual_end_whatever_the_display_cadence(world):
    """Display polls at :00 and :10; the stream ends at :03 and Holodex lists it until :10. Completion cycles run at :02:30, :07:30 ...: the
    first cycle after YouTube's actualEndTime confirms it -- 4.5 minutes later -- without waiting for the :10 snapshot to drop the stream."""
    _on_air(world, "v1")
    lifecycle.refresh_display_snapshot(now=T0)
    ended_at = T0 + timedelta(minutes=3)
    confirmed_at = None
    for cycle in range(3):
        world.clock = T0 + timedelta(minutes=2, seconds=30) + timedelta(minutes=5 * cycle)
        if world.clock >= ended_at:
            world.probes = {"v1": _probe(actualEndTime=ended_at.isoformat())}
        if world.completion()["confirmedCompleted"]:
            confirmed_at = world.clock
            break

    assert confirmed_at == T0 + timedelta(minutes=7, seconds=30)
    assert confirmed_at - ended_at <= timedelta(minutes=5)  # one completion interval, not display interval + Holodex lag + completion interval
    assert world.holodex_calls == 1  # the single display poll at :00 -- no fallback, no second poll


def test_a_stream_youtube_reports_still_live_is_left_alone(world):
    """Listed live and still on air on YouTube: no candidate, no end, nothing recorded."""
    _on_air(world, "v1")
    world.display()

    summary = world.completion()

    assert summary["completionCandidates"] == [] and summary["confirmedCompleted"] == []
    assert world.ended() == {}
    assert lifecycle._read_snapshot_record()["pendingCandidates"] == {}


def test_nothing_is_asked_of_youtube_when_nothing_is_live_or_pending(world):
    """An upcoming-only snapshot costs no YouTube quota at all."""
    world.items = [_holodex_item(video_id="v1", status="upcoming")]
    world.display()

    world.completion()

    assert world.probe_calls == []


def test_every_listed_live_stream_rides_in_one_batched_call_per_cycle(world):
    """The watch adds ONE get_archive_probe call per cycle (which batches 50 ids per videos.list request), never one call per stream."""
    ids = [f"live{i:03d}" for i in range(120)]
    _on_air(world, *ids)
    world.display()

    world.completion()
    world.clock += timedelta(minutes=5)
    world.display(minutes=0)
    world.completion()

    assert world.probe_calls == [sorted(ids), sorted(ids)]  # one call per cycle covering all 120 (the client splits it into 3 quota units)


def test_a_probe_that_got_no_answer_concludes_nothing_about_listed_streams(world):
    """No key / quota wall / network: the stream stays listed and live, nothing is recorded, and the next healthy cycle still catches the end."""
    _on_air(world, "v1")
    world.display()
    world.completion()
    world.probe_error = RuntimeError("quota wall")
    world.probes = {"v1": _probe(actualEndTime="2026-10-15T13:01:00Z")}
    world.clock += timedelta(minutes=5)

    summary = world.completion()

    assert summary["refreshed"] is True and summary["confirmedCompleted"] == []
    assert world.ended() == {}
    world.probe_error = None
    world.clock += timedelta(minutes=5)
    assert world.completion()["confirmedCompleted"] == ["v1"]


def test_a_stream_youtube_does_not_return_at_all_is_not_treated_as_ended_by_the_watch(world):
    """The watch only trusts an actualEndTime YouTube actually returned: a missing item (deleted/private) is the candidate path's business."""
    _on_air(world, "v1")
    world.display()
    world.completion()
    world.probes = {}
    world.clock += timedelta(minutes=5)

    summary = world.completion()

    assert summary["confirmedCompleted"] == [] and world.ended() == {}
    assert lifecycle._read_snapshot_record()["pendingCandidates"] == {}


def test_an_end_already_recorded_is_not_recorded_or_side_written_again_while_holodex_keeps_listing_the_stream(world, monkeypatch):
    """Holodex may keep listing the ended stream for another display interval: later cycles must not re-record it or rewrite Video Master."""
    writes: list[tuple[str, str]] = []

    def _record(video_id, status):
        writes.append((video_id, status))
        return True

    monkeypatch.setattr("stores.dynamodb_store.set_video_live_status", _record)
    _on_air(world, "v1")
    world.display()
    world.completion()
    world.probes = {"v1": _probe()}
    world.clock += timedelta(minutes=5)
    world.completion()
    first = dict(world.ended()["v1"])

    for _ in range(3):  # Holodex still lists it
        world.clock += timedelta(minutes=5)
        summary = world.completion()
        assert summary["confirmedCompleted"] == [] and summary["completionCandidates"] == []

    assert world.ended()["v1"] == first
    assert writes == [("v1", "completed")]  # exactly one side write


def test_a_stream_recorded_ended_while_listed_is_not_a_candidate_again_when_it_finally_disappears(world, monkeypatch):
    """The end is already recorded, so the later disappearance from the snapshot has nothing left to decide."""
    writes: list[str] = []

    def _record(video_id, status):
        writes.append(video_id)
        return True

    monkeypatch.setattr("stores.dynamodb_store.set_video_live_status", _record)
    _on_air(world, "v1")
    world.display()
    world.completion()
    world.probes = {"v1": _probe()}
    world.clock += timedelta(minutes=5)
    world.completion()
    first = dict(world.ended()["v1"])
    world.items = []  # the :10 snapshot finally drops it
    world.clock += timedelta(minutes=5)
    world.display(minutes=0)

    summary = world.completion()

    assert summary["completionCandidates"] == [] and summary["confirmedCompleted"] == []
    assert world.ended()["v1"] == first
    assert writes == ["v1"]
    assert lifecycle._read_snapshot_record()["pendingCandidates"] == {}


def test_a_failed_video_master_write_for_a_still_listed_ended_stream_is_retried_not_forgotten(world, monkeypatch):
    """The still-listed stream would normally look like a false alarm and be dropped; the watch's own candidates are exempt so the write retries."""
    attempts = {"n": 0}

    def _flaky(video_id, status):
        """Fail once, then succeed."""
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise RuntimeError("throttled")
        return True

    monkeypatch.setattr("stores.dynamodb_store.set_video_live_status", _flaky)
    _on_air(world, "v1")
    world.display()
    world.completion()
    world.probes = {"v1": _probe()}
    world.clock += timedelta(minutes=5)

    first = world.completion()
    assert first["confirmedCompleted"] == ["v1"]
    assert lifecycle._read_snapshot_record()["pendingCandidates"]["v1"]["attempts"] == 1  # kept for the bounded retry, though still listed

    world.clock += timedelta(minutes=5)
    world.completion()

    assert attempts["n"] == 2
    assert lifecycle._read_snapshot_record()["pendingCandidates"] == {}
    assert len(world.ended()) == 1


# ============ a confirmed-ended Premiere is classified upload, never forced to contentType="live" ============


def _premiere_probe(**overrides):
    """What YouTube reports for a completed Premiere: actualStartTime sits right at publishedAt (is_completed_premiere's own window)."""
    probe = _probe(actualStartTime="2026-10-15T09:00:00Z", publishedAt="2026-10-15T09:00:00Z")
    probe.update(overrides)
    return probe


def test_a_confirmed_ended_premiere_already_classified_upload_is_left_upload_not_forced_live(dynamo, monkeypatch):
    """Holodex cannot tell a Premiere from a real stream, so it lists v1 as "live" like any other -- but Video Master already has it as
    contentType="upload" (api.read_api persisted that while it was still upcoming). The completion cycle must not relabel it "live"."""
    from stores.dynamodb_store import load_videos
    from stores.dynamodb_store import upsert_videos as upsert_dynamo_videos

    upsert_dynamo_videos([_video("v1", content_type="upload", live_status=None)])
    world = World(monkeypatch)
    _on_air(world, "v1")
    world.display()
    world.completion()
    world.probes = {"v1": _premiere_probe()}
    world.clock += timedelta(minutes=5)

    summary = world.completion()

    assert summary["confirmedCompleted"] == ["v1"]  # the end is still recorded exactly like an ordinary stream
    assert lifecycle._read_snapshot_record()["pendingCandidates"] == {}  # a one-time write, never retried
    [video] = [video for video in load_videos() if video.video_id == "v1"]
    assert video.content_type == "upload" and video.live_status is None  # never forced to "live"/"completed"


def test_a_confirmed_ended_premiere_with_no_video_master_row_at_all_is_retried_and_warned_not_silently_accepted(dynamo, monkeypatch, capsys):
    """set_video_classification's conditional write is rejected for TWO different reasons -- already classified (fine) or the row
    does not exist yet (a real gap, discovery has not reached it). No Video Master row is seeded here at all, so the rejection must
    be recognized as the genuine gap: warned about, and the candidate kept for a bounded retry, never silently treated as settled."""
    from stores.dynamodb_store import load_videos

    world = World(monkeypatch)
    _on_air(world, "v1")
    world.display()
    world.completion()
    world.probes = {"v1": _premiere_probe()}
    world.clock += timedelta(minutes=5)

    summary = world.completion()

    assert summary["confirmedCompleted"] == ["v1"]  # the end itself is still recorded regardless
    assert lifecycle._read_snapshot_record()["pendingCandidates"]["v1"]["attempts"] == 1  # kept for a bounded retry, not forgotten
    assert "missing" in capsys.readouterr().out
    assert load_videos() == []  # no row was fabricated to work around the gap


def test_a_retried_premiere_classification_succeeds_once_discovery_creates_the_row(dynamo, monkeypatch):
    """The bounded retry actually recovers: once a later discovery run creates the Video Master row (independent of this
    lifecycle), the next completion cycle's retry classifies it and stops retrying."""
    from stores.dynamodb_store import load_videos
    from stores.dynamodb_store import upsert_videos as upsert_dynamo_videos

    world = World(monkeypatch)
    _on_air(world, "v1")
    world.display()
    world.completion()
    world.probes = {"v1": _premiere_probe()}
    world.clock += timedelta(minutes=5)
    world.completion()
    assert lifecycle._read_snapshot_record()["pendingCandidates"]["v1"]["attempts"] == 1

    upsert_dynamo_videos([_video("v1", content_type=None, live_status=None)])  # discovery catches up independently
    world.clock += timedelta(minutes=5)
    world.completion()

    assert lifecycle._read_snapshot_record()["pendingCandidates"] == {}
    [video] = [video for video in load_videos() if video.video_id == "v1"]
    assert video.content_type == "upload" and video.live_status is None


def test_an_ordinary_completed_livestream_is_still_classified_live_completed_exactly_as_before(dynamo, monkeypatch):
    """Regression: a real stream (no actualStartTime/publishedAt Premiere shape) keeps the original contentType="live" behavior."""
    from stores.dynamodb_store import load_videos
    from stores.dynamodb_store import upsert_videos as upsert_dynamo_videos

    upsert_dynamo_videos([_video("v1", content_type="live", live_status="live")])
    world = World(monkeypatch)
    _on_air(world, "v1")
    world.display()
    world.completion()
    world.probes = {"v1": _probe()}  # no actualStartTime: never mistaken for a Premiere
    world.clock += timedelta(minutes=5)

    summary = world.completion()

    assert summary["confirmedCompleted"] == ["v1"]
    [video] = [video for video in load_videos() if video.video_id == "v1"]
    assert video.content_type == "live" and video.live_status == "completed"


def test_a_confirmed_available_premiere_archive_records_the_independent_archived_notification(dynamo, monkeypatch):
    """The SECOND, independent new-video notification phase (notification_events_store.record_premiere_archived_event) is recorded
    the moment the SAME completion cycle that confirms the end also verifies the archive available -- no extra cycle, no extra probe."""
    world = World(monkeypatch)
    recorded = []
    monkeypatch.setattr(
        "stores.notification_events_store.record_premiere_archived_event", lambda **kwargs: recorded.append(kwargs) or True
    )
    _on_air(world, "v1")
    world.display()
    world.completion()
    world.probes = {"v1": _premiere_probe()}
    world.clock += timedelta(minutes=5)

    summary = world.completion()

    assert summary["confirmedCompleted"] == ["v1"]
    assert world.ended()["v1"]["archive"]["status"] == lifecycle.ARCHIVE_AVAILABLE
    assert [call["video_id"] for call in recorded] == ["v1"]
    assert recorded[0]["creator_id"] == "aizawa_ema"


def test_an_ordinary_completed_livestream_archive_never_triggers_the_premiere_archived_notification(dynamo, monkeypatch):
    """Regression: a real stream's own archive-available confirmation must never generate this second notification -- it already
    has its own, separate notification path, and must not get a duplicate, unrelated push."""
    world = World(monkeypatch)
    recorded = []
    monkeypatch.setattr(
        "stores.notification_events_store.record_premiere_archived_event", lambda **kwargs: recorded.append(kwargs) or True
    )
    _on_air(world, "v1")
    world.display()
    world.completion()
    world.probes = {"v1": _probe()}  # no actualStartTime: an ordinary stream, never mistaken for a Premiere
    world.clock += timedelta(minutes=5)

    summary = world.completion()

    assert summary["confirmedCompleted"] == ["v1"]
    assert world.ended()["v1"]["archive"]["status"] == lifecycle.ARCHIVE_AVAILABLE
    assert recorded == []


def test_a_failed_premiere_archived_notification_write_never_blocks_archive_availability(dynamo, monkeypatch):
    """Best-effort: the archive IS available regardless of whether the extra notification could be recorded."""
    world = World(monkeypatch)
    monkeypatch.setattr(
        "stores.notification_events_store.record_premiere_archived_event",
        lambda **kwargs: (_ for _ in ()).throw(RuntimeError("table down")),
    )
    _on_air(world, "v1")
    world.display()
    world.completion()
    world.probes = {"v1": _premiere_probe()}
    world.clock += timedelta(minutes=5)

    summary = world.completion()

    assert summary["confirmedCompleted"] == ["v1"]
    assert world.ended()["v1"]["archive"]["status"] == lifecycle.ARCHIVE_AVAILABLE


def test_the_premiere_archived_notification_is_never_recorded_while_the_archive_is_still_pending(dynamo, monkeypatch):
    """Only the cycle that confirms ARCHIVE_AVAILABLE may record the notification -- never while a Premiere's archive is still
    being retried (ARCHIVE_PENDING), and never for a confirmed-ended-but-not-yet-probed state either."""
    world = World(monkeypatch)
    recorded = []
    monkeypatch.setattr(
        "stores.notification_events_store.record_premiere_archived_event", lambda **kwargs: recorded.append(kwargs) or True
    )
    _on_air(world, "v1")
    world.display()
    world.completion()
    # Not yet finished processing (YouTube's own uploadStatus): the archive stays ARCHIVE_PENDING this cycle.
    world.probes = {"v1": _premiere_probe(uploadStatus="uploaded")}
    world.clock += timedelta(minutes=5)
    world.completion()

    assert world.ended()["v1"]["archive"]["status"] == lifecycle.ARCHIVE_PENDING
    assert recorded == []  # not yet -- the archive is not confirmed available

    world.probes = {"v1": _premiere_probe(uploadStatus="processed")}
    world.clock += timedelta(minutes=5)
    world.completion()

    assert world.ended()["v1"]["archive"]["status"] == lifecycle.ARCHIVE_AVAILABLE
    assert [call["video_id"] for call in recorded] == ["v1"]  # recorded exactly once, the cycle it actually became available


def test_a_rejected_not_an_exception_video_master_write_is_retried_not_silently_dropped(world, monkeypatch):
    """set_video_live_status's conditional write can be rejected (return False) without raising -- the bug this task fixes. Previously
    the return value was never checked, so a persistently-missing/mismatched Video Master record for a real stream was silently
    dropped forever; now it is retried exactly like a raised exception, bounded by the same _MAX_PENDING_ATTEMPTS."""
    calls = {"n": 0}

    def _always_rejected(video_id, status):
        calls["n"] += 1
        return False

    monkeypatch.setattr("stores.dynamodb_store.set_video_live_status", _always_rejected)
    _on_air(world, "v1")
    world.display()
    world.completion()
    world.probes = {"v1": _probe()}
    world.clock += timedelta(minutes=5)

    first = world.completion()

    assert first["confirmedCompleted"] == ["v1"]  # the end itself is still recorded
    assert calls["n"] == 1
    assert lifecycle._read_snapshot_record()["pendingCandidates"]["v1"]["attempts"] == 1  # kept for a bounded retry, not forgotten

    world.clock += timedelta(minutes=5)
    world.completion()

    assert calls["n"] == 2
    assert lifecycle._read_snapshot_record()["pendingCandidates"]["v1"]["attempts"] == 2
    assert len(world.ended()) == 1  # the end state itself was never re-recorded or duplicated


# ============ a stream shorter than one snapshot interval ============


def test_a_stream_that_went_live_and_ended_between_two_snapshots_is_still_confirmed_ended(world):
    """Listed only as UPCOMING (its start has passed) in the last snapshot; YouTube knows the broadcast already ended. With the old 1-minute poll this
    stream would have been seen live; with 10 minutes it never is, so the watch also covers past-start upcoming streams."""
    world.items = [_holodex_item(video_id="v1", status="upcoming", start_scheduled="2026-10-15T12:50:00Z")]  # start passed before T0 (13:00)
    world.probes = {"v1": _probe(actualEndTime="2026-10-15T12:58:00Z")}
    world.display()

    summary = world.completion()

    assert summary["confirmedCompleted"] == ["v1"]
    assert world.ended()["v1"]["actualEnd"] == "2026-10-15T12:58:00Z"


def test_an_upcoming_stream_whose_start_is_still_ahead_is_not_asked_about(world):
    """Nothing to learn yet: no YouTube quota is spent on streams that cannot have started."""
    world.items = [_holodex_item(video_id="v1", status="upcoming", start_scheduled="2026-10-16T01:00:00Z")]
    world.probes = {"v1": _probe(actualEndTime="2026-10-15T12:58:00Z")}
    world.display()

    world.completion()

    assert world.probe_calls == [] and world.ended() == {}


def test_a_past_start_upcoming_stream_that_never_started_is_left_alone(world):
    """Late or cancelled: YouTube has no actualEndTime, so nothing is concluded (an unstarted stream is not an end)."""
    world.items = [_holodex_item(video_id="v1", status="upcoming", start_scheduled="2026-10-15T12:50:00Z")]
    world.probes = {"v1": _probe(actualEndTime=None)}
    world.display()

    summary = world.completion()

    assert summary["confirmedCompleted"] == [] and world.ended() == {}
    assert lifecycle._read_snapshot_record()["pendingCandidates"] == {}


# ============ the archive lookup window is anchored to the END ============


def _confirm_promptly(world, **probe_overrides):
    """v1 ends; the very next completion cycle (live-end watch) confirms it, YouTube describing the archive with `probe_overrides` (default: a
    ready, public, embeddable one). Returns YouTube's end time."""
    _on_air(world, "v1")
    world.display()
    ended_at = world.clock - timedelta(minutes=1)
    world.probes = {"v1": _probe(actualEndTime=ended_at.isoformat(), **probe_overrides)}
    assert world.completion()["confirmedCompleted"] == ["v1"]
    world.items = []  # Holodex drops it from now on
    return ended_at


def _cycle(world, ended_at, *, minutes_after_end, probe):
    """One completion cycle `minutes_after_end` after the stream's end, with YouTube answering `probe` for it."""
    world.clock = ended_at + timedelta(minutes=minutes_after_end)
    world.probes = {"v1": probe}
    world.display(minutes=0)
    world.completion()
    return world.ended()["v1"]["archive"]


def test_a_promptly_confirmed_end_keeps_probing_for_the_archive_beyond_three_attempts_until_twenty_minutes_after_the_end(world):
    """Attempt 1 is 2 minutes after the end here, so a bare 3-attempt bound would stop at ~12 minutes -- before YouTube has typically finished
    processing (production: the third attempt of the old schedule landed 14-16 minutes after the end and was needed by 14% of archives)."""
    ended_at = _confirm_promptly(world, uploadStatus="uploaded")
    processing = _probe(actualEndTime=ended_at.isoformat(), uploadStatus="uploaded")

    for minutes in (6, 11, 16):  # attempts 2, 3 and 4: the third attempt no longer ends the lookup
        archive = _cycle(world, ended_at, minutes_after_end=minutes, probe=processing)
        assert archive["status"] == lifecycle.ARCHIVE_PENDING, f"handed off too early at {minutes} min after the end"

    ready = _probe(actualEndTime=ended_at.isoformat(), uploadStatus="processed")
    archive = _cycle(world, ended_at, minutes_after_end=18, probe=ready)  # processed 18 minutes after the end: the old 3-attempt bound would have missed it
    assert archive["status"] == lifecycle.ARCHIVE_AVAILABLE
    assert archive["attempts"] == 5


def test_an_archive_that_never_becomes_ready_is_handed_off_only_after_the_window_and_at_least_three_attempts(world):
    """Bounded: still processing at 20 minutes after the end (and 3+ attempts made) -> handed to the daily task, never probed again."""
    ended_at = _confirm_promptly(world, uploadStatus="uploaded")
    processing = _probe(actualEndTime=ended_at.isoformat(), uploadStatus="uploaded")

    for minutes in (6, 11, 16, 19):
        assert _cycle(world, ended_at, minutes_after_end=minutes, probe=processing)["status"] == lifecycle.ARCHIVE_PENDING
    archive = _cycle(world, ended_at, minutes_after_end=21, probe=processing)

    assert archive["status"] == lifecycle.ARCHIVE_HANDED_OFF
    assert archive["reason"] == "still_processing" and archive["attempts"] == 6
    calls = len(world.probe_calls)
    _cycle(world, ended_at, minutes_after_end=26, probe=processing)
    assert len(world.probe_calls) == calls  # a handed-off stream is never looked up here again


def test_the_minimum_attempts_still_apply_when_the_window_has_already_closed(world):
    """An end confirmed long after it happened (the old path, a long outage) keeps exactly the old rule: three attempts, then hand-off."""
    world.items = [_holodex_item(video_id="v1", status="live")]
    world.display()
    world.completion()
    world.items = []
    old_end = world.clock - timedelta(hours=2)
    world.probes = {"v1": _probe(actualEndTime=old_end.isoformat(), uploadStatus="uploaded")}
    world.clock += timedelta(minutes=5)
    world.display(minutes=0)

    world.completion()  # attempt 1
    assert world.ended()["v1"]["archive"]["status"] == lifecycle.ARCHIVE_PENDING
    for _ in range(2):  # attempts 2 and 3
        world.clock += timedelta(minutes=5)
        world.display(minutes=0)
        world.completion()

    archive = world.ended()["v1"]["archive"]
    assert archive["status"] == lifecycle.ARCHIVE_HANDED_OFF and archive["attempts"] == lifecycle.ARCHIVE_LOOKUP_MAX_ATTEMPTS


def test_an_archive_ready_on_the_first_look_is_recorded_available_at_once(world):
    """The common fast case: no extra waiting is introduced."""
    ended_at = _confirm_promptly(world)

    archive = world.ended()["v1"]["archive"]
    assert archive["status"] == lifecycle.ARCHIVE_AVAILABLE and archive["attempts"] == 1
    assert world.clock - ended_at <= timedelta(minutes=5)


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"privacyStatus": "private"}, "not_public"),
        ({"embeddable": False}, "not_embeddable"),
        ({"channelId": "UC_someone_else"}, "channel_mismatch"),
    ],
)
def test_verified_archive_eligibility_is_unchanged_by_the_longer_window(world, overrides, reason):
    """A private / non-embeddable / other-channel archive is never marked available, however long the lookup keeps going: it is handed off with
    its specific reason once the window closes, while the END itself stays confirmed."""
    ended_at = _confirm_promptly(world, **overrides)
    ineligible = _probe(actualEndTime=ended_at.isoformat(), **overrides)

    assert world.ended()["v1"]["archive"]["status"] == lifecycle.ARCHIVE_PENDING  # never "available"
    for minutes in (6, 11, 16, 19):
        assert _cycle(world, ended_at, minutes_after_end=minutes, probe=ineligible)["status"] == lifecycle.ARCHIVE_PENDING
    archive = _cycle(world, ended_at, minutes_after_end=21, probe=ineligible)

    assert archive["status"] == lifecycle.ARCHIVE_HANDED_OFF and archive["reason"] == reason
    assert world.ended()["v1"]["endState"] == lifecycle.END_STATE_ENDED


# ============ freshness accessor used by the dispatcher ============


def test_the_display_freshness_accessor_is_none_before_anything_was_ever_persisted(dynamo):
    """Never persisted: None (the dispatcher then falls back to its own interval rule)."""
    assert lifecycle.read_display_refreshed_at() is None


def test_the_display_freshness_accessor_follows_the_heartbeat_without_reading_the_large_item(dynamo, monkeypatch):
    """After a run that changed nothing only the heartbeat moved; the accessor reports it and never touches the large snapshot record."""
    world = World(monkeypatch)
    world.items = [_holodex_item(video_id="v1", status="live")]
    world.display()
    first = world.clock
    world.display(minutes=10)  # unchanged: heartbeat only
    reads: list[str] = []
    real_read = lifecycle._read_record
    monkeypatch.setattr(lifecycle, "_read_record", lambda key: (reads.append(key), real_read(key))[1])

    assert lifecycle.read_display_refreshed_at() == first + timedelta(minutes=10)
    assert reads == [lifecycle.DISPLAY_HEARTBEAT_KEY]


def test_the_display_freshness_accessor_falls_back_to_a_record_written_before_the_heartbeat_existed(dynamo):
    """A legacy display record has only its own refreshedAt."""
    lifecycle._put_display_record({"streams": [], "refreshedAt": T0.isoformat()}, T0)

    assert lifecycle.read_display_refreshed_at() == T0


# ============ the serving bounds at the new cadence ============


@pytest.mark.parametrize(
    ("age_seconds", "outcome"),
    [
        (30, "served"),  # just refreshed
        (599, "served"),  # the oldest a healthy 10-minute snapshot ever gets
        (1200, "served"),  # one whole run missed
        (lifecycle.MAX_SNAPSHOT_AGE_SECONDS, "served"),  # three runs missed: last second inside the bound
        (lifecycle.MAX_SNAPSHOT_AGE_SECONDS + 1, "stale"),  # beyond it: a bounded 503, never an indefinite OFFLINE
    ],
)
def test_the_snapshot_is_served_across_the_healthy_ten_minute_cycle_and_refused_only_past_the_bound(dynamo, monkeypatch, age_seconds, outcome):
    """Product cadence anchors in plain seconds so a threshold regression cannot hide behind the derived constants."""
    world = World(monkeypatch)
    world.items = [_holodex_item(video_id="v1", status="live")]
    lifecycle.refresh_display_snapshot(now=T0)
    now = T0 + timedelta(seconds=age_seconds)

    if outcome == "served":
        assert [stream["videoId"] for stream in lifecycle.read_serving_snapshot(now=now)] == ["v1"]
    else:
        with pytest.raises(lifecycle.LiveSnapshotStaleError):
            lifecycle.read_serving_snapshot(now=now)


# ============ the Premiere's archive-availability time is kept durably, beyond this module's own 36-hour ended record ============


def _durable_times() -> dict:
    """The durable record's videoId -> availability time map."""
    from stores.premiere_archive_times_store import read_premiere_archive_times

    return read_premiere_archive_times()


def _confirmed_available_premiere(world, monkeypatch):
    """A Premiere whose end AND archive are confirmed in the cycle after it went off air (the notification event store is stubbed)."""
    monkeypatch.setattr("stores.notification_events_store.record_premiere_archived_event", lambda **kwargs: True)
    _on_air(world, "v1")
    world.display()
    world.completion()
    world.probes = {"v1": _premiere_probe()}
    world.clock += timedelta(minutes=5)
    return world.completion()


def test_a_confirmed_available_premiere_archive_keeps_its_availability_time_durably(dynamo, monkeypatch):
    """The lifecycle's own verified availableAt is copied as it is into the durable record the recent-videos API reads."""
    world = World(monkeypatch)

    _confirmed_available_premiere(world, monkeypatch)

    assert world.ended()["v1"]["archive"]["status"] == lifecycle.ARCHIVE_AVAILABLE
    assert _durable_times() == {"v1": world.ended()["v1"]["archive"]["availableAt"]}


def test_the_durable_time_outlives_the_ended_record_after_its_36_hour_retention(dynamo, monkeypatch):
    """After RECENTLY_ENDED_RETENTION the lifecycle forgets the stream, but the replay's availability time is still on record."""
    world = World(monkeypatch)
    _confirmed_available_premiere(world, monkeypatch)
    recorded_time = _durable_times()["v1"]

    world.clock += lifecycle.RECENTLY_ENDED_RETENTION + timedelta(hours=1)
    world.display()
    world.completion()

    assert "v1" not in world.ended()  # the lifecycle record has expired
    assert _durable_times() == {"v1": recorded_time}  # the durable time is unchanged


def test_an_ordinary_completed_livestream_archive_records_no_premiere_time_and_reads_nothing(dynamo, monkeypatch):
    """Only a completed Premiere is recorded; a real stream's archive leaves the durable record untouched, and the durable record is not even read."""
    reads = []
    monkeypatch.setattr("stores.premiere_archive_times_store.read_premiere_archive_times", lambda: reads.append(1) or {})
    world = World(monkeypatch)
    _on_air(world, "v1")
    world.display()
    world.completion()
    world.probes = {"v1": _probe()}
    world.clock += timedelta(minutes=5)

    world.completion()

    assert world.ended()["v1"]["archive"]["status"] == lifecycle.ARCHIVE_AVAILABLE
    assert reads == []  # no completed Premiere is retained: no extra DynamoDB read at all


def test_a_pending_premiere_archive_is_not_recorded_until_it_is_confirmed_available(dynamo, monkeypatch):
    """No availability time exists while the archive is still processing: nothing is recorded, nothing is invented."""
    monkeypatch.setattr("stores.notification_events_store.record_premiere_archived_event", lambda **kwargs: True)
    world = World(monkeypatch)
    _on_air(world, "v1")
    world.display()
    world.completion()
    world.probes = {"v1": _premiere_probe(uploadStatus="uploaded")}
    world.clock += timedelta(minutes=5)
    world.completion()

    assert world.ended()["v1"]["archive"]["status"] == lifecycle.ARCHIVE_PENDING
    assert _durable_times() == {}

    world.probes = {"v1": _premiere_probe(uploadStatus="processed")}
    world.clock += timedelta(minutes=5)
    world.completion()

    assert _durable_times() == {"v1": world.ended()["v1"]["archive"]["availableAt"]}


def test_a_failed_durable_write_never_blocks_the_archive_and_the_next_cycle_retries_it(dynamo, monkeypatch):
    """Best-effort and self-healing: while the entry is retained, every cycle re-offers it, and recording is idempotent."""
    from stores import premiere_archive_times_store as times_store

    real = times_store.record_premiere_archive_times
    attempts = []

    def flaky(new_times, *, now):
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("table down")
        return real(new_times, now=now)

    monkeypatch.setattr(times_store, "record_premiere_archive_times", flaky)
    world = World(monkeypatch)

    summary = _confirmed_available_premiere(world, monkeypatch)

    assert summary["confirmedCompleted"] == ["v1"] and world.ended()["v1"]["archive"]["status"] == lifecycle.ARCHIVE_AVAILABLE
    assert _durable_times() == {}  # the first write failed

    world.clock += timedelta(minutes=5)
    world.completion()

    assert _durable_times() == {"v1": world.ended()["v1"]["archive"]["availableAt"]}
    world.clock += timedelta(minutes=5)
    world.completion()
    assert len(_durable_times()) == 1  # the same video id, never a second record
