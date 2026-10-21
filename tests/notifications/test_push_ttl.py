"""The Web Push TTL: every send passes an explicit positive TTL to the push service, sized to what the notification says.

`pywebpush` sends TTL=0 by default ("deliver now or drop"); a phone that is offline for a minute would lose the notification. These tests prove (1) the
sender always hands a positive TTL to `webpush()`, (2) each notification type gets a lifetime that fits it -- a new video stays deliverable for up to a day
after publication, while an advance reminder, a start reminder and a simultaneous-livestream notice cannot outlive their moment -- and (3) the dispatchers
actually pass that lifetime, end to end. A TTL bounds how long an UNDELIVERED message is kept; it is not a delivery guarantee.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from notifications import live_reminder, new_video_dispatcher, push_sender, push_ttl
from tests.notifications.new_video_harness import DAY1_EVENING, due_event, fake_delivery_log, install_world, preference_value
from tests.notifications.test_simultaneous_dispatch import A, B, START as SIM_START, follower, show, vA, vB, world  # noqa: F401  (world is a fixture)
from tests.notifications.test_scheduled_start_notifications import START, harness  # noqa: F401  (harness is a fixture)

UTC = timezone.utc
SUBSCRIPTION = {"endpoint": "https://fcm.googleapis.com/fcm/send/abc123", "keys": {"p256dh": "p256dh-value", "auth": "auth-value"}}
CLAIMS = {"sub": "mailto:test@example.com"}


def _ms(moment: datetime) -> int:
    """Epoch milliseconds of `moment`."""
    return int(moment.timestamp() * 1000)


# ============ the sender: an explicit, positive TTL always reaches pywebpush ============


def _capture(monkeypatch) -> list[dict]:
    """Replace pywebpush's webpush() with a recorder of its keyword arguments."""
    calls: list[dict] = []
    monkeypatch.setattr(push_sender, "webpush", lambda **kwargs: calls.append(kwargs))
    return calls


def _send(**overrides):
    """send_push_notification with throwaway arguments."""
    arguments = {"title": "t", "body": "b", "data": None, "vapid_private_key": "k", "vapid_claims": CLAIMS, **overrides}
    return push_sender.send_push_notification(SUBSCRIPTION, **arguments)


def test_the_ttl_the_caller_names_is_passed_to_the_push_service_explicitly(monkeypatch):
    """webpush() receives `ttl` itself, so the library's default of 0 can never apply."""
    calls = _capture(monkeypatch)

    assert _send(ttl_seconds=5400).sent is True

    assert calls[0]["ttl"] == 5400


def test_a_caller_that_names_no_ttl_still_never_sends_ttl_zero(monkeypatch):
    """The default is a positive lifetime, passed explicitly like any other."""
    calls = _capture(monkeypatch)

    _send()

    assert calls[0]["ttl"] == push_ttl.DEFAULT_TTL_SECONDS
    assert calls[0]["ttl"] > 0


@pytest.mark.parametrize("bad", [0, -1, True, 1.5, "60", None])
def test_a_ttl_that_is_not_a_positive_integer_is_a_failed_send_and_never_reaches_the_push_service(monkeypatch, bad):
    """TTL 0 is exactly what this change removes: a zero, negative or non-integer lifetime is refused before anything is sent."""
    calls = _capture(monkeypatch)

    result = _send(ttl_seconds=bad)

    assert result.sent is False and result.retryable is False and "TTL" in result.error
    assert calls == []


def test_the_bounded_retry_resends_with_the_same_ttl(monkeypatch):
    """Both attempts of send_with_bounded_retry carry the lifetime the caller chose."""
    monkeypatch.setattr(push_sender, "_RETRY_PAUSE_SECONDS", 0)
    calls: list[dict] = []

    def fail_once(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise push_sender.requests.ConnectionError("reset")

    monkeypatch.setattr(push_sender, "webpush", fail_once)

    result = push_sender.send_with_bounded_retry(SUBSCRIPTION, title="t", body="b", data=None, vapid_private_key="k", vapid_claims=CLAIMS, ttl_seconds=777)

    assert result.sent is True
    assert [call["ttl"] for call in calls] == [777, 777]


# ============ the lifetimes themselves ============


def test_a_new_video_stays_deliverable_for_up_to_a_day_after_it_was_discovered():
    """Sent at once: the full 24 h. Held back by quiet hours: what is left of the day. Never below an hour."""
    discovered = datetime(2026, 9, 2, 9, 0, tzinfo=UTC)

    assert push_ttl.new_video_ttl_seconds(discovered_at=discovered, now=discovered) == 24 * 3600
    assert push_ttl.new_video_ttl_seconds(discovered_at=discovered, now=discovered + timedelta(hours=10)) == 14 * 3600
    assert push_ttl.new_video_ttl_seconds(discovered_at=discovered, now=discovered + timedelta(hours=23, minutes=50)) == 3600
    assert push_ttl.new_video_ttl_seconds(discovered_at=discovered, now=discovered + timedelta(days=3)) == 3600


def test_an_advance_reminder_and_a_simultaneous_notice_live_exactly_until_the_scheduled_start():
    """What is true before the start is false after it: the push service must not hold the message past it."""
    now = datetime(2026, 9, 2, 12, 0, tzinfo=UTC)

    for minutes_before in (1, 10, 30, 60):
        start = now + timedelta(minutes=minutes_before)
        assert push_ttl.advance_reminder_ttl_seconds(scheduled_start_ms=_ms(start), now=now) == minutes_before * 60


def test_a_time_sensitive_lifetime_is_never_zero_and_never_longer_than_a_day():
    """A start that is seconds away (or already behind us) still gets a positive TTL; a start days away is capped at 24 h."""
    now = datetime(2026, 9, 2, 12, 0, tzinfo=UTC)

    assert push_ttl.advance_reminder_ttl_seconds(scheduled_start_ms=_ms(now + timedelta(seconds=3)), now=now) == push_ttl.MIN_TIME_SENSITIVE_TTL_SECONDS
    assert push_ttl.advance_reminder_ttl_seconds(scheduled_start_ms=_ms(now - timedelta(minutes=5)), now=now) == push_ttl.MIN_TIME_SENSITIVE_TTL_SECONDS
    assert push_ttl.advance_reminder_ttl_seconds(scheduled_start_ms=_ms(now + timedelta(days=4)), now=now) == push_ttl.MAX_TTL_SECONDS


def test_a_start_reminder_expires_a_short_grace_after_the_scheduled_start():
    """The scheduled start has arrived: useful for a few minutes, not for hours."""
    start = datetime(2026, 9, 2, 12, 0, tzinfo=UTC)
    grace = push_ttl.START_REMINDER_GRACE_SECONDS

    assert push_ttl.start_reminder_ttl_seconds(scheduled_start_ms=_ms(start), now=start) == grace
    assert push_ttl.start_reminder_ttl_seconds(scheduled_start_ms=_ms(start), now=start + timedelta(minutes=4)) == grace - 240
    assert push_ttl.start_reminder_ttl_seconds(scheduled_start_ms=_ms(start), now=start + timedelta(hours=2)) == push_ttl.MIN_TIME_SENSITIVE_TTL_SECONDS
    assert grace <= 15 * 60  # never anywhere near the new-video lifetime


def test_the_time_sensitive_lifetimes_are_far_below_the_new_video_lifetime():
    """The regression guard for 'one TTL for everything': a late reminder must not be deliverable the next day."""
    now = datetime(2026, 9, 2, 12, 0, tzinfo=UTC)
    reminder = push_ttl.advance_reminder_ttl_seconds(scheduled_start_ms=_ms(now + timedelta(hours=1)), now=now)
    start = push_ttl.start_reminder_ttl_seconds(scheduled_start_ms=_ms(now), now=now)
    video = push_ttl.new_video_ttl_seconds(discovered_at=now, now=now)

    assert reminder <= 3600 and start <= 600 and video == 24 * 3600


# ============ end to end: what each dispatcher really passes ============


def test_new_video_notifications_reach_the_push_service_with_the_remaining_day_as_ttl(monkeypatch):
    """Discovered 09-02 18:00 JST (09:00 UTC) and sent at 09-03 09:05 UTC: 24 h - 24 h 5 min is under the floor, so the floor (1 h) applies; the
    same event sent soon after discovery gets nearly the whole day."""
    fake_delivery_log(monkeypatch)
    calls = _capture(monkeypatch)
    install_world(monkeypatch, events=[due_event()], preferences={"c1": preference_value()}, stub_push=False)

    new_video_dispatcher.run({}, None, now=DAY1_EVENING)

    assert [call["ttl"] for call in calls] == [push_ttl.MIN_NEW_VIDEO_TTL_SECONDS]


def test_a_new_video_sent_soon_after_discovery_is_held_for_nearly_a_day(monkeypatch):
    """The event is discovered 09-03 18:00 JST (09:00 UTC) and its slot arrives at 09:05 UTC the same day."""
    fake_delivery_log(monkeypatch)
    calls = _capture(monkeypatch)
    event = due_event(eventDate="2026-09-03", discoveredAt="2026-09-03T17:50:00+09:00")
    install_world(monkeypatch, events=[event], preferences={"c1": preference_value()}, stub_push=False)

    new_video_dispatcher.run({}, None, now=datetime(2026, 9, 3, 9, 5, tzinfo=UTC))

    assert len(calls) == 1
    assert 23 * 3600 <= calls[0]["ttl"] <= 24 * 3600


def test_a_start_reminder_is_sent_with_a_short_grace_ttl(harness):  # noqa: F811
    """The default harness client wants the at-start notice: it goes out in the minute of the scheduled start."""
    harness.run(START + timedelta(seconds=10))

    assert [push["ttl"] for push in harness.pushes] == [push_ttl.START_REMINDER_GRACE_SECONDS - 10]


@pytest.mark.parametrize("advance", ["1min", "10min", "30min", "1hour"])
def test_an_advance_reminder_is_sent_with_a_ttl_that_ends_at_the_start(harness, advance):  # noqa: F811
    """Fired `offset` minutes before the start (10 s into its minute): it may be held at most until the stream starts."""
    offset = live_reminder.ADVANCE_REMINDER_OFFSET_MINUTES[advance]
    harness.config[("c1", live_reminder.creator_reminder_key("aizawa_ema", "all"))] = {"notifyAtStart": False, "advanceReminder": advance}

    harness.run(START - timedelta(minutes=offset) + timedelta(seconds=10))

    assert len(harness.pushes) == 1
    assert harness.pushes[0]["ttl"] == offset * 60 - 10


def test_a_simultaneous_notice_never_outlives_the_shared_start(world):  # noqa: F811
    """Two creators collide at the shared start 2 hours from now: the notice may be kept for those 2 hours and not a second more."""
    follower(world, "c1", creators=(A, B))

    show(world, [vA(), vB()], SIM_START - timedelta(hours=2))

    assert [push["ttl"] for push in world.pushes] == [2 * 3600]


def test_a_simultaneous_notice_sent_in_the_last_seconds_still_gets_a_positive_ttl(world):  # noqa: F811
    """A notice discovered 5 seconds before the start (it is still true) is never sent with TTL 0 or a negative value."""
    follower(world, "c1", creators=(A, B))

    show(world, [vA(), vB()], SIM_START - timedelta(seconds=5))

    assert [push["ttl"] for push in world.pushes] == [push_ttl.MIN_TIME_SENSITIVE_TTL_SECONDS]
