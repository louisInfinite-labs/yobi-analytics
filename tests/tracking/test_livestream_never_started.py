"""Regression tests for the NEVER-STARTED signal (tracking.livestream_lifecycle UNSTARTED WATCH "dropped" evidence, GET /live-streams `neverStarted`).

Arya Kuroha 2Qm0bOp7sks (2026-11-16): Holodex listed her stream "live" with no actualStart, then DROPPED it from its list before the lifecycle had two
observations. YouTube kept showing the waiting room ("upcoming", LIVE_STREAM_OFFLINE), so no actualEndTime ever came: the stream was never reported ended and
nothing told a browser that had remembered it "live overnight" to stop holding the Schedule on its date -- it stayed pinned until its 24 h memory ran out.

The signal is explicit YouTube evidence in several separate cycles about a stream Holodex never gave an actualStart. What must NOT change is just as important and
tested here: genuine streams (a real start on YouTube or from Holodex, multi-day marathons across upstream gaps), inconclusive YouTube answers (unanswered, not
returned, field-less, started, ended), late starts, and "never ended" -- a never-started stream is not an ended stream.

Same harness as test_livestream_unstarted_watch.py: only the Holodex HTTP boundary and the YouTube probe are mocked, every upstream request is counted.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from api import read_api
from tests.tracking.test_livestream_lifecycle import T0, _holodex_item, _probe, dynamo, world  # noqa: F401 -- shared fixtures and builders
from tests.tracking.test_livestream_unstarted_watch import ARYA, NARIN, _confirm, _cycle, _false_live, _iso, _on_air, _statuses, _waiting_room, served  # noqa: F401
from tracking import livestream_lifecycle as lifecycle


def _never_started() -> list[str]:
    """The videoIds GET /live-streams lists in `neverStarted` right now."""
    return [entry["videoId"] for entry in read_api.get_live_streams().get("neverStarted", [])]


def _arya_vanishes(w, *, observed_while_listed=1):
    """Arya's exact production sequence: listed "live" with no actualStart, observed `observed_while_listed` time(s), then Holodex drops her. Returns the
    summary of the first cycle that no longer lists her."""
    w.items = [_false_live(ARYA, 33)]
    w.probes = {ARYA: _waiting_room()}
    w.display()
    w.completion()
    for _ in range(observed_while_listed - 1):
        _cycle(w)
    w.items = []
    return _cycle(w)


# ============ Arya: the confirmed production case ============


def test_arya_dropped_after_one_observation_is_released_once_a_second_cycle_agrees(served):
    """One observation while listed, then Holodex drops her: the pending candidate is followed, the second agreeing cycle (5 minutes later) confirms it."""
    w = served

    summary = _arya_vanishes(w)

    assert summary["neverStarted"] == [ARYA]
    body = read_api.get_live_streams()
    assert body["streams"] == []  # she is not listed any more
    assert [entry["videoId"] for entry in body["neverStarted"]] == [ARYA]
    assert body["neverStarted"][0]["confirmedAt"] == w.clock.isoformat()
    assert not body.get("recentlyEnded")  # NOT ended: it never started
    assert w.ended() == {}
    assert lifecycle._read_unstarted_record()[ARYA]["dropped"] is True


def test_arya_dropped_without_ever_being_confirmed_while_listed_needs_two_cycles_after_it(served):
    """If the first cycle that ever sees the video is the one without it ... nothing is guessed: an observation counts only with YouTube's explicit answer."""
    w = served
    w.items = [_false_live(ARYA, 33)]
    w.probes = {}  # YouTube returned nothing for it while listed: no observation yet
    w.display()
    w.completion()
    assert lifecycle._read_unstarted_record() == {}
    w.items = []
    w.probes = {ARYA: _waiting_room()}

    _cycle(w)
    assert _never_started() == []  # ONE observation is never enough

    _cycle(w)
    assert _never_started() == [ARYA]


def test_a_stream_confirmed_while_listed_is_released_in_the_first_cycle_after_holodex_drops_it(served):
    """Narin's shape: already confirmed unstarted and served "upcoming"; when Holodex drops it the same evidence carries on at once."""
    w = served
    w.items = [_false_live(NARIN, 29)]
    w.probes = {NARIN: _waiting_room()}
    _confirm(w)
    assert _statuses() == {NARIN: "upcoming"}
    assert _never_started() == []  # still listed: it is served as "upcoming", nothing to release

    w.items = []
    _cycle(w)

    assert _never_started() == [NARIN]
    assert w.ended() == {}


def test_the_hold_signal_is_refreshed_every_cycle_while_youtube_keeps_showing_the_waiting_room(served):
    """An abandoned waiting room stays "upcoming" for days: the signal is re-confirmed every cycle, so a browser that opens hours later still gets it."""
    w = served
    _arya_vanishes(w)

    for _ in range(40):  # about three hours
        _cycle(w)
        assert _never_started() == [ARYA]
    assert lifecycle._read_unstarted_record()[ARYA]["observations"] > 40


# ============ what must NOT be released ============


def test_a_dropped_stream_that_ever_carried_an_actual_start_is_never_confirmed(served):
    """Holodex's own start evidence wins: a stream whose last listing had an actualStart is a real broadcast, whatever a stale YouTube answer says."""
    w = served
    w.items = [_holodex_item(video_id=ARYA, status="live", start_scheduled=_iso(T0 - timedelta(hours=40)), start_actual=_iso(T0 - timedelta(hours=39)))]
    w.probes = {ARYA: _waiting_room()}  # even a (stale) "upcoming" answer must not matter
    w.display()
    w.completion()
    w.items = []

    for _ in range(4):
        _cycle(w)

    assert _never_started() == []
    assert lifecycle._read_unstarted_record() == {}


def test_a_marathon_that_is_on_air_per_youtube_is_never_released_across_an_upstream_gap(served):
    """A multi-day stream Holodex loses for a while (no actualStart in its copy) while YouTube says "live": never confirmed, however long the gap."""
    w = served
    w.items = [_false_live(ARYA, 60)]  # Holodex has no actualStart for it ...
    w.probes = {ARYA: _on_air()}  # ... but YouTube says it is on air with an actual start
    w.display()
    w.completion()
    w.items = []  # an upstream gap

    for _ in range(12):  # an hour
        _cycle(w)
        assert _never_started() == []
    assert lifecycle._read_unstarted_record() == {}


@pytest.mark.parametrize(
    "answer",
    [
        pytest.param(_probe(actualEndTime=None, actualStartTime=None, liveBroadcastContent="live"), id="live_without_start_time"),
        pytest.param(_probe(actualEndTime=None, actualStartTime=None), id="field_less"),
        pytest.param(_probe(actualEndTime=None, actualStartTime=None, liveBroadcastContent="none"), id="none"),
        pytest.param(_probe(actualEndTime=None, actualStartTime="2026-10-15T12:00:00Z", liveBroadcastContent="upcoming"), id="upcoming_but_started"),
        pytest.param(_probe(actualEndTime="2026-10-15T13:00:00Z", actualStartTime=None, liveBroadcastContent="upcoming"), id="upcoming_but_ended"),
        pytest.param(None, id="not_returned_by_youtube"),
    ],
)
def test_an_inconclusive_youtube_answer_never_releases_anything(served, answer):
    """Only an explicit "upcoming" with no start and no end counts. Anything else -- missing field, started, ended, video not returned (e.g. a members-only
    video the Data API does not return) -- is inconclusive: the signal never appears and the existing holding behaviour is exactly as before."""
    w = served
    w.items = [_false_live(ARYA, 33)]
    w.probes = {ARYA: _waiting_room()}
    w.display()
    w.completion()
    w.items = []
    w.probes = {} if answer is None else {ARYA: answer}

    for _ in range(4):
        _cycle(w)

    assert _never_started() == []


def test_an_unanswered_probe_confirms_nothing_and_the_signal_expires_with_the_evidence(served):
    """YouTube unreachable / quota exhausted: nothing is learned. A signal already given is honoured only UNSTARTED_EVIDENCE_MAX_AGE after the last
    observation, then it goes -- the hold then simply falls back to the browser's own 24 h memory (the safe direction)."""
    w = served
    _arya_vanishes(w)
    assert _never_started() == [ARYA]

    w.probe_error = RuntimeError("youtube unavailable")
    for _ in range(3):  # 15 minutes: still inside the freshness window
        _cycle(w)
    assert _never_started() == [ARYA]
    last = lifecycle._read_unstarted_record()[ARYA]["lastObservedAt"]

    for _ in range(2):  # 25 minutes since the last observation
        _cycle(w)
    assert _never_started() == []
    assert lifecycle._read_unstarted_record() == {}
    assert last  # the chain had really been observed before the outage

    w.probe_error = None  # YouTube is back: the chain starts over and needs two agreeing cycles again
    _cycle(w)
    assert _never_started() == []
    _cycle(w)
    assert _never_started() == [ARYA]


def test_one_observation_or_two_too_close_together_never_releases(served):
    """Two cycles must agree AND span at least UNSTARTED_MIN_SPAN: one stale YouTube reading cannot release a hold."""
    w = served
    w.items = [_false_live(ARYA, 33)]
    w.probes = {ARYA: _waiting_room()}
    w.display()
    w.completion()
    w.items = []
    w.display(minutes=0)
    assert w.completion()["skipped"] == "duplicate_invocation"  # a re-delivered invocation is not a second observation
    assert _never_started() == []

    _cycle(w, minutes=2)  # a second observation, but only two minutes after the first
    assert lifecycle._read_unstarted_record()[ARYA]["observations"] == 2
    assert _never_started() == []

    _cycle(w, minutes=2)  # four minutes
    assert _never_started() == [ARYA]


# ============ late start, relisting, ends ============


def test_a_dropped_stream_that_really_starts_hours_late_is_no_longer_released_and_is_live_again(served):
    """The released stream starts after all: YouTube reports the start, the evidence is gone at once, and as soon as Holodex lists it with an actualStart
    it is live (and holds the Schedule date again in the browser). Nothing was ever written as ended."""
    w = served
    _arya_vanishes(w)
    assert _never_started() == [ARYA]

    w.probes = {ARYA: _on_air()}
    _cycle(w)
    assert _never_started() == []
    assert lifecycle._read_unstarted_record() == {}

    w.items = [_holodex_item(video_id=ARYA, status="live", start_scheduled=_iso(T0 - timedelta(hours=33)), start_actual=_iso(w.clock))]
    _cycle(w)
    assert _statuses() == {ARYA: "live"}
    assert _never_started() == []
    assert w.ended() == {}


def test_a_stale_signal_never_lists_a_stream_that_the_listing_carries_live_with_an_actual_start(served):
    """Holodex's start evidence always wins at request time too: the evidence may be up to 20 minutes old, but a stream the listing shows live WITH an
    actualStart is never in `neverStarted`."""
    w = served
    _arya_vanishes(w)
    assert _never_started() == [ARYA]

    w.items = [_holodex_item(video_id=ARYA, status="live", start_scheduled=_iso(T0 - timedelta(hours=33)), start_actual=_iso(w.clock))]
    w.display(minutes=1)  # the display snapshot now lists it live with an actualStart; the lifecycle has not run again

    assert _statuses() == {ARYA: "live"}
    assert _never_started() == []


def test_a_dropped_stream_that_holodex_lists_again_goes_back_to_the_listed_rules(served):
    """Relisted "live" with no actualStart: judged as a listed stream again (served "upcoming" on the same evidence), no longer a dropped one."""
    w = served
    _arya_vanishes(w)
    assert _never_started() == [ARYA]

    w.items = [_false_live(ARYA, 33)]
    _cycle(w)

    assert _never_started() == []
    assert _statuses() == {ARYA: "upcoming"}
    assert "dropped" not in lifecycle._read_unstarted_record()[ARYA]


def test_a_dropped_stream_that_youtube_later_reports_ended_is_recorded_ended_and_leaves_the_signal(served):
    """It did start (and finish) after all: the existing end watch records the end from YouTube's actualEndTime, and the never-started signal is gone."""
    w = served
    _arya_vanishes(w)
    assert _never_started() == [ARYA]

    w.probes = {ARYA: _probe(actualStartTime="2026-10-15T11:00:00Z", actualEndTime="2026-10-15T12:00:00Z", liveBroadcastContent="none")}
    _cycle(w)

    assert _never_started() == []
    assert ARYA in w.ended()


def test_the_signal_is_never_an_end(served):
    """A never-started stream is not an ended stream: no recentlyEnded entry, no ended record, no Video Master write, no status change."""
    w = served
    _arya_vanishes(w)
    for _ in range(3):
        _cycle(w)

    body = read_api.get_live_streams()

    assert [entry["videoId"] for entry in body["neverStarted"]] == [ARYA]
    assert not body.get("recentlyEnded")
    assert w.ended() == {}
    assert lifecycle._read_snapshot_record()["pendingCandidates"][ARYA]["attempts"] == 0


# ============ boundedness, request economy, API robustness ============


def test_a_dropped_stream_is_no_longer_followed_after_its_memory_window(served):
    """Followed for UNSTARTED_DROPPED_MAX_AGE after it vanished (the Schedule's own 24 h memory), so the record cannot grow without bound."""
    w = served
    _arya_vanishes(w)
    entry = lifecycle._read_unstarted_record()[ARYA]
    dropped_at = lifecycle._parse_moment(entry["droppedAt"])
    probes = {ARYA: _waiting_room()}

    inside = lifecycle._track_unstarted({}, probes, {ARYA}, {ARYA: entry}, dropped_at + lifecycle.UNSTARTED_DROPPED_MAX_AGE - timedelta(minutes=1) + timedelta(seconds=0), {ARYA: {"scheduledStart": None, "droppedAt": entry["droppedAt"]}})
    outside = lifecycle._track_unstarted({}, probes, {ARYA}, {ARYA: entry}, dropped_at + lifecycle.UNSTARTED_DROPPED_MAX_AGE + timedelta(minutes=1), {ARYA: {"scheduledStart": None, "droppedAt": entry["droppedAt"]}})

    assert ARYA in inside
    assert outside == {}


def test_following_a_dropped_stream_adds_no_youtube_request(served):
    """The dropped streams ride in the batched call the cycle already makes: exactly one videos.list call per cycle, and no Holodex request beyond the
    display refresh."""
    w = served
    _arya_vanishes(w)
    calls_before, holodex_before = len(w.probe_calls), w.holodex_calls

    _cycle(w)

    assert len(w.probe_calls) - calls_before == 1
    assert ARYA in w.probe_calls[-1]
    assert w.holodex_calls - holodex_before == 1  # the display refresh of that cycle, nothing else


def test_the_field_is_omitted_when_there_is_nothing_to_release_and_never_changes_the_streams(served):
    """Additive: no evidence -> no field; with evidence the `streams` list is identical to what it is without it."""
    w = served
    w.items = [_holodex_item(video_id="up1", status="upcoming", start_scheduled=_iso(T0 + timedelta(hours=2)))]
    w.display()
    w.completion()
    assert "neverStarted" not in read_api.get_live_streams()
    plain = read_api.get_live_streams()["streams"]

    w.items = [*w.items, _false_live(ARYA, 33)]
    w.probes = {ARYA: _waiting_room()}
    _cycle(w)  # observed once while listed
    w.items = w.items[:1]
    _cycle(w)  # dropped, second agreeing observation

    body = read_api.get_live_streams()
    assert [entry["videoId"] for entry in body["neverStarted"]] == [ARYA]
    assert body["streams"] == plain


def test_an_unreadable_evidence_record_or_another_backend_just_omits_the_field(served, monkeypatch):
    """Best effort: a read failure never fails /live-streams; the field is simply absent (every client reads that as "nothing to release")."""
    w = served
    _arya_vanishes(w)
    assert _never_started() == [ARYA]

    monkeypatch.setattr(lifecycle, "read_never_started", lambda **_: (_ for _ in ()).throw(RuntimeError("store down")))
    body = read_api.get_live_streams()
    assert "neverStarted" not in body and body["streams"] == []

    monkeypatch.undo()
    monkeypatch.setenv("YOBI_STORAGE_BACKEND", "file")
    assert read_api._read_never_started([]) == []


def test_no_start_or_live_reminder_is_derived_from_a_never_started_stream(served):
    """The signal changes nothing the dispatcher derives its schedule from: a dropped stream is not in the listing at all, and `streams` is untouched."""
    w = served
    _arya_vanishes(w)
    assert read_api.get_live_streams()["streams"] == []
    assert _statuses() == {}
