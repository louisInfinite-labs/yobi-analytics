"""The diagnostic line that lets the ~65 s reminder lateness be explained from production logs (patch 1: no behaviour change)."""

from __future__ import annotations

import json
from datetime import timedelta

from notifications import notification_dispatcher
from tests.notifications.test_scheduled_start_notifications import START, Harness, _frozen


def _timing_lines(capsys) -> list[dict]:
    """The parsed `Dispatch timing:` records printed so far."""
    return [json.loads(line.split("Dispatch timing: ", 1)[1]) for line in capsys.readouterr().out.splitlines() if line.startswith("Dispatch timing: ")]


def _run(monkeypatch, wall, event):
    """One idle dispatcher invocation at `wall` with `event`."""
    Harness(monkeypatch)
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen(wall))
    return notification_dispatcher.lambda_handler(event, None)


def test_the_line_records_the_scheduler_time_the_run_start_and_the_lag_between_them(monkeypatch, capsys):
    """The data that decides whether the Scheduler's nominal time precedes the invocation (and by how much)."""
    wall = START + timedelta(seconds=4.7)
    _run(monkeypatch, wall, {"scheduledTime": "2026-10-17T12:14:59Z"})

    (record,) = _timing_lines(capsys)
    assert record["scheduledTime"] == "2026-10-17T12:14:59Z"
    assert record["scheduledLagMs"] == 5700
    assert record["now"].startswith("2026-10-17T12:15:04.7")
    assert record["instants"] and record["instants"][-1]["ageMs"] in (0, 5700)


def test_a_run_without_a_scheduled_time_is_logged_as_such(monkeypatch, capsys):
    """Before the Scheduler input existed (and for a manual invoke) there is simply no scheduled time."""
    _run(monkeypatch, START, {})

    (record,) = _timing_lines(capsys)
    assert record["scheduledTime"] is None and record["scheduledLagMs"] is None and record["usedScheduledTime"] is False


def test_the_line_carries_no_client_video_or_creator_identifier(monkeypatch, capsys):
    """Clock facts only."""
    _run(monkeypatch, START, {"scheduledTime": "2026-10-17T12:14:59Z"})
    line = [l for l in capsys.readouterr().out.splitlines() if l.startswith("Dispatch timing: ")][0]

    assert set(json.loads(line.split("Dispatch timing: ", 1)[1])) == {
        "now", "scheduledTime", "scheduledLagMs", "usedScheduledTime", "warmContainer", "instants", "nowSecond", "scheduledSecond", "dueAtNow", "dueAtInstants", "deferredByInstant",
    }


def test_the_line_can_be_switched_off_with_an_environment_variable(monkeypatch, capsys):
    """YOBI_DISPATCH_TIMING_LOG=0 silences it without a code change."""
    monkeypatch.setenv("YOBI_DISPATCH_TIMING_LOG", "0")
    _run(monkeypatch, START, {})

    assert _timing_lines(capsys) == []


def test_a_malformed_scheduled_time_never_breaks_the_run(monkeypatch, capsys):
    """A diagnostic must not be able to fail a reminder minute."""
    summary = _run(monkeypatch, START, {"scheduledTime": {"not": "a string"}})

    assert summary["statusCode"] == 200


# ---- the counterfactual: the production symptom, counted per run (patch 1 alone changes no behaviour; these tests hold with and without patch 2's rule)

def _run_with_stream(monkeypatch, wall, event):
    """One dispatcher run at `wall` for a world whose schedule holds one stream starting at START and one subscriber who wants its start."""
    from tests.notifications.test_scheduled_start_notifications import AT_START, SNAPSHOT_AT, _stream

    monkeypatch.setattr(notification_dispatcher, "_MAX_RECOVERY_LOOKBACK", timedelta(minutes=10))
    monkeypatch.setattr(notification_dispatcher, "_last_served_ms", None)
    world = Harness(monkeypatch)
    world.add_client("c1", creator_reminders={"aizawa_ema": AT_START})
    world.refresh_snapshot([_stream("v1")], SNAPSHOT_AT)
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen(wall))
    return notification_dispatcher.lambda_handler(event, None)


def test_a_nominal_time_before_the_minute_boundary_is_counted_as_a_reminder_deferred_by_the_instant(monkeypatch, capsys):
    """The 65 s mechanism seen directly: at START+4.7 s the stream is due at the clock, but the Scheduler's nominal time (START-1 s) predates its start --
    with the pre-fix rule that nominal time IS the served instant, so the reminder is deferred (deferredByInstant = 1); with the fixed rule the run serves
    the clock and nothing is deferred."""
    from notifications import notification_dispatcher as nd

    trusted = nd._scheduled_instant({"scheduledTime": "2026-10-17T12:14:59Z"}, START + timedelta(seconds=4.7)) is not None
    _run_with_stream(monkeypatch, START + timedelta(seconds=4.7), {"scheduledTime": "2026-10-17T12:14:59Z"})

    (record,) = _timing_lines(capsys)
    assert record["dueAtNow"] == 1
    assert record["deferredByInstant"] == (1 if trusted else 0)
    assert record["scheduledSecond"] == 59 and record["nowSecond"] == 4.7


def test_a_nominal_time_on_the_boundary_defers_nothing(monkeypatch, capsys):
    """The control: the nominal time at :00 or later still reaches a start on the minute, whichever rule is in force."""
    _run_with_stream(monkeypatch, START + timedelta(seconds=4.7), {"scheduledTime": "2026-10-17T12:15:00Z"})

    (record,) = _timing_lines(capsys)
    assert record["dueAtNow"] == 1 and record["dueAtInstants"] == 1 and record["deferredByInstant"] == 0


def test_an_idle_minute_counts_zero_everywhere(monkeypatch, capsys):
    """Most minutes have nothing due: the counters are zero and cost no storage operation (the schedule is already in memory)."""
    _run_with_stream(monkeypatch, START - timedelta(hours=3), {})

    (record,) = _timing_lines(capsys)
    assert (record["dueAtNow"], record["dueAtInstants"], record["deferredByInstant"]) == (0, 0, 0)


# ---- privacy: the line must carry no personal identifier or subscription detail, even in a world full of them

def test_the_line_contains_no_client_creator_video_title_or_subscription_detail_in_a_world_full_of_them(monkeypatch, capsys):
    """Run a real due minute for several subscribers (their ids, push endpoints, keys, the creator, the video id and its title all exist in the world) and prove
    that NOTHING of it appears in anything the dispatcher printed on the timing line -- by searching every identifying string the world holds."""
    from tests.notifications.test_scheduled_start_notifications import AT_START, SNAPSHOT_AT, _stream

    monkeypatch.setattr(notification_dispatcher, "_MAX_RECOVERY_LOOKBACK", timedelta(minutes=10))
    monkeypatch.setattr(notification_dispatcher, "_last_served_ms", None)
    world = Harness(monkeypatch)
    for client in ("client-aaaa-1111", "client-bbbb-2222"):
        world.add_client(client, creator_reminders={"aizawa_ema": AT_START})
    world.refresh_snapshot([_stream("secretVideo1", title="Secret Title ZZZ")], SNAPSHOT_AT)
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen(START + timedelta(seconds=4.7)))

    notification_dispatcher.lambda_handler({"scheduledTime": "2026-10-17T12:14:59Z"}, None)

    out = capsys.readouterr().out
    line = next(l for l in out.splitlines() if l.startswith("Dispatch timing: "))
    for forbidden in ("client-aaaa-1111", "client-bbbb-2222", "push.example", "https://", "p256dh", "auth", "secretVideo1", "Secret Title ZZZ", "aizawa_ema", "endpoint", "keys", "mailto", "@"):
        assert forbidden not in line, forbidden
    assert len(line) < 1024
    # every value is a number, a bool, null, an ISO timestamp or the Scheduler's own timestamp string
    record = json.loads(line.split("Dispatch timing: ", 1)[1])
    for key, value in record.items():
        assert key == "instants" or value is None or isinstance(value, (bool, int, float, str)), key
        if isinstance(value, str):
            assert key in ("now", "scheduledTime") and len(value) <= 40


def test_a_scheduled_time_that_is_not_a_timestamp_is_never_copied_into_the_log(monkeypatch, capsys):
    """Only a parsable timestamp is echoed; free text (a mistyped manual invoke) is reported as "unparsable"."""
    _run(monkeypatch, START, {"scheduledTime": "free text with a name: someone@example.com"})

    (record,) = _timing_lines(capsys)
    assert record["scheduledTime"] == "unparsable" and "someone" not in json.dumps(record)
