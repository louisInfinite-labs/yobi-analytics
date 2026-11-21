"""Regression tests for the UNSTARTED WATCH (tracking.livestream_lifecycle): a stream Holodex keeps listing "live" although YouTube still shows its
waiting room ("upcoming", never started) is served as "upcoming" by GET /live-streams -- on YouTube's explicit evidence only, never on a missing
actualStart alone -- and everything that must NOT change (genuine live streams, late starts, members-only / unavailable videos, ends).

Confirmed production cases (2026-11-16): Arya Kuroha 2Qm0bOp7sks and Narin Mikure 2tOFQ_vG7s4 were served "live" with actualStart null about 33 and 29
hours after their scheduled start while YouTube showed both as upcoming (one a Members Only waiting room).

Same harness as test_livestream_lifecycle.py: only the Holodex HTTP boundary and the YouTube probe are mocked, every upstream request is counted.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from api import read_api
from notifications import live_reminder, notification_dispatcher
from tests.tracking.test_livestream_lifecycle import T0, _holodex_item, _probe, dynamo, world  # noqa: F401 -- shared fixtures and builders
from tracking import livestream_lifecycle as lifecycle

ARYA = "2Qm0bOp7sks"  # Arya Kuroha: APEX, scheduled Sun 08:00 JST, never started
NARIN = "2tOFQ_vG7s4"  # Narin Mikure: Members Only, scheduled Sun 12:30 JST, never started


def _iso(moment: datetime) -> str:
    """The Holodex timestamp shape."""
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _false_live(video_id: str, hours_overdue: float, title: str = "Stream") -> dict:
    """What Holodex reported for the confirmed cases: status live, a scheduled start long past, NO actual start."""
    return _holodex_item(video_id=video_id, status="live", title=title, start_scheduled=_iso(T0 - timedelta(hours=hours_overdue)), start_actual=None)


def _waiting_room(**overrides) -> dict:
    """YouTube's answer for a waiting room that never started: explicit "upcoming", no actual start, no actual end."""
    return _probe(actualEndTime=None, actualStartTime=None, liveBroadcastContent="upcoming", scheduledStartTime="2026-10-14T00:00:00Z", **overrides)


def _on_air(**overrides) -> dict:
    """YouTube's answer for a broadcast that is on air: "live" with an actual start."""
    return _probe(actualEndTime=None, actualStartTime="2026-10-15T12:00:00Z", liveBroadcastContent="live", **overrides)


@pytest.fixture
def served(world, monkeypatch):
    """GET /live-streams as production serves it: the DynamoDB backend, the evidence read fresh on every call, and the clock pinned to the World's."""
    monkeypatch.setenv("YOBI_STORAGE_BACKEND", "dynamodb")
    monkeypatch.setattr(lifecycle, "ENDED_CACHE_SECONDS", 0)
    lifecycle.reset_unstarted_cache()

    class _Pinned(datetime):
        """A datetime whose now() is the World's clock (the snapshot ages are evaluated against it)."""

        @classmethod
        def now(cls, tz=None):
            """The World's current instant."""
            return world.clock if tz is None else world.clock.astimezone(tz)

    monkeypatch.setattr(lifecycle, "datetime", _Pinned)
    monkeypatch.setattr(read_api, "datetime", _Pinned)
    return world


def _cycle(w, minutes=5):
    """One completion cycle `minutes` after the previous action, on a fresh display snapshot."""
    w.clock += timedelta(minutes=minutes)
    w.display(minutes=0)
    return w.completion()


def _statuses() -> dict[str, str]:
    """videoId -> status exactly as GET /live-streams serves it."""
    return {stream["videoId"]: stream["status"] for stream in read_api.get_live_streams()["streams"]}


def _confirm(w, *, cycles=2):
    """Run the first `cycles` completion cycles of an unchanged picture (the first one starts from a fresh display snapshot)."""
    w.display()
    summary = w.completion()
    for _ in range(cycles - 1):
        summary = _cycle(w)
    return summary


# ============ the two confirmed false-LIVE videos ============


def test_the_two_confirmed_false_live_videos_are_served_upcoming_once_two_cycles_agree(served):
    """Holodex says live with no actualStart; YouTube's explicit answer is "upcoming" in two separate cycles: both are served "upcoming" -- not
    ended, not dropped, scheduled start and everything else untouched."""
    w = served
    w.items = [_false_live(ARYA, 33, "【APEX LEGENDS】solo un-washing !!"), _false_live(NARIN, 29, "【Members Only】 um.. short zatsu")]
    w.probes = {ARYA: _waiting_room(), NARIN: _waiting_room()}

    w.display()
    w.completion()
    assert _statuses() == {ARYA: "live", NARIN: "live"}  # ONE observation is never enough

    summary = _cycle(w)

    assert _statuses() == {ARYA: "upcoming", NARIN: "upcoming"}
    assert summary["unstartedLive"] == sorted([ARYA, NARIN])
    body = read_api.get_live_streams()
    by_id = {stream["videoId"]: stream for stream in body["streams"]}
    assert by_id[ARYA]["actualStart"] is None and by_id[ARYA]["scheduledStart"] == _iso(T0 - timedelta(hours=33)).replace("Z", "+00:00")
    assert by_id[NARIN]["title"] == "【Members Only】 um.. short zatsu"
    assert not body.get("recentlyEnded")  # a stream that never started is never reported ended
    assert w.ended() == {}


def test_a_single_observation_or_two_too_close_together_never_flips_a_stream(served):
    """A re-delivered invocation is ignored (it cannot count as a second observation), and two cycles less than UNSTARTED_MIN_SPAN apart do not confirm."""
    w = served
    w.items = [_false_live(ARYA, 33)]
    w.probes = {ARYA: _waiting_room()}
    w.display()
    w.completion()
    assert w.completion()["skipped"] == "duplicate_invocation"
    assert lifecycle._read_unstarted_record()[ARYA]["observations"] == 1

    _cycle(w, minutes=2)  # a second, but only two minutes later

    assert lifecycle._read_unstarted_record()[ARYA]["observations"] == 2
    assert _statuses()[ARYA] == "live"  # span 2 min < UNSTARTED_MIN_SPAN
    _cycle(w, minutes=2)
    assert _statuses()[ARYA] == "upcoming"  # span 4 min


@pytest.mark.parametrize("hours_overdue", [2, 33, 120])
def test_an_overdue_waiting_room_is_served_upcoming_however_long_overdue(served, hours_overdue):
    """Overdue by hours or days: the same evidence, the same outcome."""
    w = served
    w.items = [_false_live(ARYA, hours_overdue)]
    w.probes = {ARYA: _waiting_room()}

    _confirm(w)

    assert _statuses() == {ARYA: "upcoming"}


# ============ late starts ============


def test_a_stream_that_starts_late_returns_to_live_when_youtube_reports_the_start(served):
    """Demoted as a waiting room, then YouTube reports the start (Holodex still without actualStart): the next completion cycle drops the evidence and
    the stream is live again; its later end is recorded exactly like any other."""
    w = served
    w.items = [_false_live(ARYA, 33)]
    w.probes = {ARYA: _waiting_room()}
    _confirm(w)
    assert _statuses() == {ARYA: "upcoming"}

    w.probes = {ARYA: _on_air()}
    _cycle(w)

    assert _statuses() == {ARYA: "live"}
    assert lifecycle._read_unstarted_record() == {}
    assert [entry["videoId"] for entry in lifecycle._read_snapshot_record()["liveBaseline"]] == [ARYA]  # now observed live: it counts for end detection
    w.probes = {ARYA: _probe(actualStartTime="2026-10-15T14:00:00Z", actualEndTime="2026-10-15T16:00:00Z", liveBroadcastContent="none")}
    assert _cycle(w)["confirmedCompleted"] == [ARYA]  # a genuine end, after a genuine start


def test_holodexs_own_actual_start_wins_immediately_even_while_the_evidence_is_still_fresh(served):
    """The evidence is still on record, but the display snapshot now carries an actualStart: the stream is live at once, before any lifecycle cycle."""
    w = served
    w.items = [_false_live(ARYA, 33)]
    w.probes = {ARYA: _waiting_room()}
    _confirm(w)
    assert _statuses() == {ARYA: "upcoming"}

    w.items = [_holodex_item(video_id=ARYA, status="live", start_scheduled=_iso(T0 - timedelta(hours=33)), start_actual=_iso(w.clock))]
    w.display()  # the 10-minute display refresh only: no completion cycle in between

    assert ARYA in lifecycle.read_unstarted_video_ids()  # the evidence is still fresh...
    assert _statuses() == {ARYA: "live"}  # ...and still does not override Holodex's own start evidence


def test_a_stream_that_starts_hours_late_stays_upcoming_throughout_and_then_goes_live(served):
    """Three hours of waiting room (36 cycles), then the broadcast really starts: upcoming the whole time, live afterwards, one YouTube call per cycle."""
    w = served
    w.items = [_false_live(ARYA, 33)]
    w.probes = {ARYA: _waiting_room()}
    _confirm(w)
    for _ in range(34):
        _cycle(w)
        assert _statuses() == {ARYA: "upcoming"}
    w.probes = {ARYA: _on_air()}
    _cycle(w)

    assert _statuses() == {ARYA: "live"}
    assert w.probe_calls == [[ARYA]] * 37


# ============ members-only, unavailable and inconclusive evidence ============


def test_a_video_youtube_does_not_return_is_never_concluded_unstarted(served):
    """A members-only or otherwise unreturned video: no evidence, so nothing changes -- it is not demoted, not ended, and the record is not written."""
    w = served
    w.items = [_false_live(NARIN, 29, "【Members Only】")]
    w.probes = {}

    for _ in range(6):
        _cycle(w)

    assert _statuses() == {NARIN: "live"}
    assert lifecycle._read_unstarted_record() == {}
    assert w.ended() == {}
    assert [entry["videoId"] for entry in lifecycle._read_snapshot_record()["liveBaseline"]] == [NARIN]  # unchanged behaviour


def test_a_members_only_waiting_room_youtube_does_return_is_served_upcoming(served):
    """The members-only case that was returned by the probe: the same explicit evidence applies."""
    w = served
    w.items = [_false_live(NARIN, 29, "【Members Only】")]
    w.probes = {}
    for _ in range(3):
        _cycle(w)
    assert _statuses() == {NARIN: "live"}

    w.probes = {NARIN: _waiting_room()}
    _cycle(w)
    _cycle(w)

    assert _statuses() == {NARIN: "upcoming"}


@pytest.mark.parametrize(
    "probe",
    [
        pytest.param(_probe(actualEndTime=None), id="field-missing-older-probe-shape"),
        pytest.param(_probe(actualEndTime=None, liveBroadcastContent=None), id="field-null"),
        pytest.param(_probe(actualEndTime=None, liveBroadcastContent="none"), id="state-none"),
        pytest.param(_probe(actualEndTime=None, liveBroadcastContent="live"), id="live-without-actual-start-yet-youtube-lag"),
        pytest.param(_probe(actualEndTime=None, actualStartTime="2026-10-15T12:00:00Z", liveBroadcastContent="upcoming"), id="contradictory-start-present"),
    ],
)
def test_missing_or_inconclusive_youtube_metadata_never_demotes(served, probe):
    """Anything short of an explicit "upcoming" with no actual start or end changes nothing."""
    w = served
    w.items = [_false_live(ARYA, 33)]
    w.probes = {ARYA: probe}

    for _ in range(5):
        _cycle(w)

    assert _statuses() == {ARYA: "live"}
    assert lifecycle._read_unstarted_record() == {}


def test_an_unanswered_probe_concludes_nothing_and_the_evidence_expires_instead_of_being_trusted_forever(served):
    """No key / quota wall / network: existing evidence is neither extended nor cleared -- it simply stops being honoured after
    UNSTARTED_EVIDENCE_MAX_AGE, and the listing then reverts to Holodex's own."""
    w = served
    w.items = [_false_live(ARYA, 33)]
    w.probes = {ARYA: _waiting_room()}
    _confirm(w)
    assert _statuses() == {ARYA: "upcoming"}

    w.probe_error = RuntimeError("quota wall")
    for _ in range(3):  # 15 minutes after the last observation
        _cycle(w)
    assert _statuses() == {ARYA: "upcoming"}
    for _ in range(3):  # 30 minutes
        _cycle(w)

    assert _statuses() == {ARYA: "live"}
    w.probe_error = None
    _cycle(w)
    _cycle(w)
    assert _statuses() == {ARYA: "upcoming"}  # healthy again: re-confirmed after two cycles


def test_the_evidence_is_honoured_only_while_fresh_if_the_lifecycle_stops(served):
    """The completion job stops entirely: ten minutes later the demotion still holds, after twenty-one it no longer does."""
    w = served
    w.items = [_false_live(ARYA, 33)]
    w.probes = {ARYA: _waiting_room()}
    _confirm(w)

    w.clock += timedelta(minutes=10)
    assert _statuses() == {ARYA: "upcoming"}
    w.clock += timedelta(minutes=11)
    assert _statuses() == {ARYA: "live"}


# ============ genuine live streams ============


def test_a_genuine_live_stream_with_a_temporarily_missing_actual_start_is_never_demoted(served):
    """Holodex has not filled actualStart yet, but YouTube says the broadcast is live with an actualStartTime: live throughout."""
    w = served
    w.items = [_false_live(ARYA, 0.1)]
    w.probes = {ARYA: _on_air()}

    for _ in range(6):
        _cycle(w)

    assert _statuses() == {ARYA: "live"}
    assert lifecycle._read_unstarted_record() == {}


def test_holodexs_actual_start_is_never_contradicted_by_a_stale_youtube_reading(served):
    """Holodex lists the stream live WITH its actualStart; a lagging YouTube answer says "upcoming": never tracked, never demoted."""
    w = served
    w.items = [_holodex_item(video_id=ARYA, status="live")]
    w.probes = {ARYA: _waiting_room()}

    for _ in range(6):
        _cycle(w)

    assert _statuses() == {ARYA: "live"}
    assert lifecycle._read_unstarted_record() == {}


def test_a_legitimate_multi_day_live_stream_stays_live(served):
    """A marathon that has been on air for three days (Holodex actualStart three days ago, YouTube live) is untouched: live, observed live, no evidence."""
    w = served
    w.items = [_holodex_item(video_id=ARYA, status="live", start_actual=_iso(T0 - timedelta(days=3)))]
    w.probes = {ARYA: _on_air()}

    for _ in range(8):
        _cycle(w)

    assert _statuses() == {ARYA: "live"}
    assert [entry["videoId"] for entry in lifecycle._read_snapshot_record()["liveBaseline"]] == [ARYA]
    assert lifecycle._read_unstarted_record() == {}
    assert w.ended() == {}


# ============ never an end ============


def test_a_confirmed_unstarted_stream_that_vanishes_is_never_recorded_as_ended(served):
    """Holodex finally drops the stream: it was never observed live, so it is not an ended-candidate, nothing is recorded ended, and the evidence goes."""
    w = served
    w.items = [_false_live(ARYA, 33)]
    w.probes = {ARYA: _waiting_room()}
    _confirm(w)
    assert [entry["videoId"] for entry in lifecycle._read_snapshot_record()["liveBaseline"]] == []  # excluded from the live baseline

    w.items = []
    for _ in range(3):
        _cycle(w)

    assert w.ended() == {}
    assert lifecycle._read_snapshot_record()["pendingCandidates"] == {}
    assert lifecycle._read_unstarted_record() == {}


def test_a_stream_youtube_reports_ended_is_still_confirmed_by_the_live_end_watch(served):
    """The watch does not interfere with the existing end confirmation: an actualEndTime still ends the stream."""
    w = served
    w.items = [_false_live(ARYA, 33)]
    w.probes = {ARYA: _waiting_room()}
    _confirm(w)

    w.probes = {ARYA: _probe(actualStartTime="2026-10-15T11:00:00Z", actualEndTime="2026-10-15T12:00:00Z", liveBroadcastContent="none")}
    summary = _cycle(w)

    assert summary["confirmedCompleted"] == [ARYA]
    assert w.ended()[ARYA]["endState"] == lifecycle.END_STATE_ENDED
    assert ARYA not in _statuses()  # ended streams are dropped from the live list exactly as before
    assert lifecycle._read_unstarted_record() == {}


# ============ cost, requests and writes ============


def test_no_extra_youtube_or_holodex_request_is_made_for_the_watch_or_for_serving(served):
    """One probe call per completion cycle covering the listed-live ids (as before); reading /live-streams makes no upstream request at all."""
    w = served
    w.items = [_false_live(ARYA, 33), _false_live(NARIN, 29)]
    w.probes = {ARYA: _waiting_room(), NARIN: _waiting_room()}
    _confirm(w, cycles=3)
    probe_calls, holodex_calls = list(w.probe_calls), w.holodex_calls

    for _ in range(5):
        _statuses()

    assert probe_calls == [sorted([ARYA, NARIN])] * 3
    assert (w.probe_calls, w.holodex_calls) == (probe_calls, holodex_calls)


def test_the_evidence_record_is_written_only_while_there_is_evidence(served, monkeypatch):
    """No stream, no record write. With evidence: one small write per completion cycle. When it clears: one final write, then none."""
    writes: list[str] = []
    real_put = lifecycle._put_record
    monkeypatch.setattr(lifecycle, "_put_record", lambda key, value, moment: (writes.append(key), real_put(key, value, moment))[1])
    w = served
    w.items = [_holodex_item(video_id=ARYA, status="live")]  # an ordinary live stream
    w.probes = {ARYA: _on_air()}
    for _ in range(3):
        _cycle(w)
    assert lifecycle.UNSTARTED_STREAMS_KEY not in writes

    w.items = [_false_live(ARYA, 33)]
    w.probes = {ARYA: _waiting_room()}
    for _ in range(3):
        _cycle(w)
    assert writes.count(lifecycle.UNSTARTED_STREAMS_KEY) == 3

    w.probes = {ARYA: _on_air()}
    for _ in range(3):
        _cycle(w)
    assert writes.count(lifecycle.UNSTARTED_STREAMS_KEY) == 4  # the final, emptying write only


def test_relabelling_never_feeds_the_unclassified_upcoming_classifier(served, monkeypatch):
    """The relabelled stream must not make get_live_streams ask YouTube to classify it: the classifier only ever sees what Holodex itself listed upcoming."""
    asked: list[list[str]] = []
    real = read_api.classify_unclassified_upcoming
    monkeypatch.setattr(read_api, "classify_unclassified_upcoming", lambda ids: (asked.append(list(ids)), real(ids))[1])
    w = served
    w.items = [_false_live(ARYA, 33)]
    w.probes = {ARYA: _waiting_room()}
    _confirm(w)

    assert _statuses() == {ARYA: "upcoming"}
    assert all(ARYA not in ids for ids in asked)


def test_an_unreadable_evidence_record_leaves_the_listing_and_the_cycle_untouched(served, monkeypatch):
    """A store failure on the evidence record: /live-streams serves Holodex's own status, and the completion cycle still completes."""
    w = served
    w.items = [_false_live(ARYA, 33)]
    w.probes = {ARYA: _waiting_room()}
    _confirm(w)
    real = lifecycle._read_record

    def flaky(key):
        if key == lifecycle.UNSTARTED_STREAMS_KEY:
            raise RuntimeError("store down")
        return real(key)

    monkeypatch.setattr(lifecycle, "_read_record", flaky)

    assert _statuses() == {ARYA: "live"}
    summary = _cycle(w)
    assert summary["refreshed"] is True
    assert lifecycle._read_unstarted_record() == {}  # unreadable -> the chain simply starts over


def test_a_non_dynamodb_backend_is_untouched(served, monkeypatch):
    """Local development and every pre-existing environment without the DynamoDB backend never reach the evidence record."""
    w = served
    w.items = [_false_live(ARYA, 33)]
    w.probes = {ARYA: _waiting_room()}
    _confirm(w)
    monkeypatch.setenv("YOBI_STORAGE_BACKEND", "local")

    assert read_api._with_unstarted_streams_as_upcoming([{"videoId": ARYA, "status": "live", "actualStart": None}]) == [{"videoId": ARYA, "status": "live", "actualStart": None}]


# ============ notifications and the schedule ============


def test_a_demoted_stream_causes_no_live_or_start_notification_and_keeps_its_schedule(served):
    """The reminder schedule is derived from get_live_streams: the stream keeps its scheduledStart, is stored as upcoming, and no start reminder, advance
    reminder or late-discovery catch-up is due for it -- before the demotion, after it, or when it finally starts hours late."""
    w = served
    w.items = [_false_live(ARYA, 33)]
    w.probes = {ARYA: _waiting_room()}
    _confirm(w)
    now = w.clock

    entries = notification_dispatcher._refresh_and_load_stream_schedule(now=now)

    entry = entries[ARYA]
    scheduled_ms = int((T0 - timedelta(hours=33)).timestamp() * 1000)
    assert entry.scheduled_start_ms == scheduled_ms and entry.status == "upcoming"
    setting = live_reminder.parse_live_reminder_setting({"notifyAtStart": True, "advanceReminder": "30min"})
    for instant in (now, now + timedelta(hours=3)):  # waiting room now, and the moment it really starts hours later
        now_ms = int(instant.timestamp() * 1000)
        assert not live_reminder.is_start_reminder_due(setting, scheduled_ms, now_ms=now_ms, window_ms=120_000)
        assert not live_reminder.is_advance_reminder_due(setting, scheduled_ms, now_ms=now_ms, window_ms=120_000)
        assert not live_reminder.is_advance_catch_up_due(
            setting, scheduled_ms, now_ms=now_ms, window_ms=120_000, status=entry.status, first_seen=None, subscription_updated_at=None
        )


# ============ schedule inputs (what the Schedule's overnight hold reads) ============


def test_the_schedules_hold_inputs_a_false_live_member_stream_stops_holding_a_genuine_one_still_does(served):
    """The overnight hold looks for a MEMBER stream that is "live" with a start before the viewer's today. The false-live waiting room is served
    "upcoming" (nothing to hold), a genuine overnight stream keeps its live status and start, and a late start restores it."""
    w = served
    genuine_start = T0 - timedelta(hours=14)
    w.items = [
        _false_live(ARYA, 33),
        _holodex_item(video_id=NARIN, status="live", start_scheduled=_iso(genuine_start), start_actual=_iso(genuine_start)),
    ]
    w.probes = {ARYA: _waiting_room(), NARIN: _on_air()}
    _confirm(w)

    by_id = {stream["videoId"]: stream for stream in read_api.get_live_streams()["streams"]}
    assert by_id[ARYA]["status"] == "upcoming"
    assert by_id[NARIN]["status"] == "live" and by_id[NARIN]["actualStart"] is not None

    w.probes = {ARYA: _on_air(), NARIN: _on_air()}  # the waiting room finally starts
    _cycle(w)
    assert _statuses() == {ARYA: "live", NARIN: "live"}
