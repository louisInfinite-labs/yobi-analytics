"""One-time Premiere reminders, end to end through notification_dispatcher.lambda_handler (premiere_reminder.py).

A client picks ONE of five times for ONE Premiere; it is delivered once through the existing Web Push path, independent of the livestream reminders
(creator 全部 / topic / stream override), the simultaneous notice and the four daily New Video slots. The Harness is the same stateful in-memory fake of
the config store, delivery log, push sender and shared live snapshot the 開播時 tests use; nothing here can reach Holodex, YouTube or AWS.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from notifications import live_reminder, notification_dispatcher, notification_text, premiere_reminder
from stores import remote_config_store
from tests.notifications.test_notification_dispatcher import _preference_value
from tests.notifications.test_scheduled_start_notifications import AT_START, SNAPSHOT_AT, START, Harness, _stream

UTC = timezone.utc
CHOICES = ("at_start", "10min", "30min", "1hour")  # what a client can save (the retired 1-minute choice is in OFFSET only, for stored legacy items)
OFFSET = {"at_start": 0, "1min": 1, "10min": 10, "30min": 30, "1hour": 60}
URL = "/creator/aizawa-ema"


def _premiere(video_id="p1", *, start: datetime = START, creator="aizawa_ema", status="premiere") -> dict:
    """One Premiere as GET /live-streams lists it while it is still upcoming."""
    return _stream(video_id, start=start, status=status, creator=creator, title="【Premiere】New original song")


def _target(choice: str, start: datetime = START) -> datetime:
    """The moment the chosen reminder is meant to fire."""
    return start - timedelta(minutes=OFFSET[choice])


def _choose(world: Harness, choice: str, *, client="c1", video="p1", creator="aizawa_ema") -> None:
    """The client stores its one-time reminder for the Premiere (what PUT /clients/{id}/premiere-reminder/{videoId} writes)."""
    world.config[(client, premiere_reminder.premiere_reminder_key(video))] = {"creatorId": creator, "reminder": choice}


def _stored(world: Harness, client="c1", video="p1"):
    return world.config.get((client, premiere_reminder.premiere_reminder_key(video)))


@pytest.fixture
def world(monkeypatch):
    """One subscriber (c1) who has NO livestream reminder of any kind and NO new-video switch, and one Premiere in the shared snapshot at :00."""
    harness = Harness(monkeypatch)
    harness.add_client("c1")
    harness.refresh_snapshot([_premiere()], SNAPSHOT_AT)
    return harness


# ============ the five choices ============


@pytest.mark.parametrize("choice", CHOICES)
def test_each_choice_fires_exactly_once_at_its_own_moment_and_never_at_the_other_four(world, choice):
    """A Premiere at 19:00 local: 首播時 19:00, 1 分鐘前 18:59, 10 分鐘前 18:50, 30 分鐘前 18:30, 1 小時前 18:00 -- alternatives, not five notifications."""
    _choose(world, choice)

    for other in sorted(CHOICES, key=lambda value: -OFFSET[value]):  # chronological: 1 hour before ... at the start
        before = len(world.pushes)
        world.run(_target(other) - timedelta(seconds=40))  # a minute-run just before that moment: never early
        assert len(world.pushes) == before
        world.run(_target(other) + timedelta(seconds=10))
        assert len(world.pushes) == before + (1 if other == choice else 0), f"choice {choice} at the {other} moment"

    assert len(world.pushes) == 1
    expected_kind = "premiere_start" if choice == "at_start" else "premiere_advance"
    assert world.pushes[0]["data"] == {"videoId": "p1", "reminderKind": expected_kind, "url": URL}
    assert world.run(START + timedelta(minutes=3))["delivered"] == 0  # nothing follows, not even the start notification of an advance choice


def test_the_exact_target_times_of_the_five_choices_for_a_local_evening_premiere():
    start_ms = int(datetime(2026, 10, 17, 10, 0, tzinfo=UTC).timestamp() * 1000)  # 19:00 JST

    def local(choice):
        return datetime.fromtimestamp(premiere_reminder.fire_at_ms(choice, start_ms) / 1000, tz=timezone(timedelta(hours=9))).strftime("%H:%M")

    assert {choice: local(choice) for choice in CHOICES} == {"at_start": "19:00", "10min": "18:50", "30min": "18:30", "1hour": "18:00"}


def test_an_advance_choice_sends_one_notification_and_no_additional_start_notification(world):
    """The livestream mapping sends 'advance AND start'; a Premiere reminder is ONE occurrence."""
    _choose(world, "10min")

    for minute in range(-70, 21):
        world.run(START + timedelta(minutes=minute, seconds=10))

    assert [push["data"]["reminderKind"] for push in world.pushes] == ["premiere_advance"]


def test_only_one_choice_exists_per_client_and_premiere_so_saving_again_replaces_it(world):
    _choose(world, "1hour")
    _choose(world, "10min")  # the same item is overwritten by the next PUT

    for minute in range(-70, 5):
        world.run(START + timedelta(minutes=minute, seconds=10))

    assert [push["data"]["reminderKind"] for push in world.pushes] == ["premiere_advance"]
    assert world.pushes[0]["title"].endswith("10 分鐘後開始") or "10 minutes" in world.pushes[0]["title"]


def test_the_wording_is_premiere_specific_in_every_locale_and_never_claims_it_is_live(world):
    for locale in ("en", "ja", "zh-TW"):
        world.add_client(f"c-{locale}", preference=_preference_value(notificationLocale=locale))
        _choose(world, "at_start", client=f"c-{locale}")
    world.run(START + timedelta(seconds=10))

    titles = {push["endpoint"].rsplit("/", 1)[1]: push for push in world.pushes}
    assert titles["c-en"]["title"].endswith("Premiere is scheduled to start now")
    assert titles["c-ja"]["title"].endswith("のプレミア公開の開始予定時刻です")
    assert titles["c-zh-TW"]["title"].endswith("的首播預定現在開始")
    for push in titles.values():
        assert push["body"] == "【Premiere】New original song"  # the original title, untouched
        assert not any(claim in push["title"] for claim in ("goes live", "is live", "開播", "配信開始", "has started", "已開始"))


@pytest.mark.parametrize(
    ("locale", "choice", "expected"),
    [
        ("en", "10min", "Premiere starts in 10 minutes"),
        ("ja", "30min", "のプレミア公開は30分後に開始"),
        ("zh-TW", "1hour", "的首播將於 1 小時後開始"),
        ("zh-TW", "10min", "的首播將於 10 分鐘後開始"),
    ],
)
def test_the_advance_wording_names_the_chosen_offset(world, locale, choice, expected):
    world.add_client("c2", preference=_preference_value(notificationLocale=locale))
    _choose(world, choice, client="c2")

    world.run(_target(choice) + timedelta(seconds=10))

    assert [push["title"] for push in world.pushes if push["endpoint"].endswith("/c2")][0].endswith(expected)


def test_the_notification_text_module_refuses_unknown_premiere_kinds():
    with pytest.raises(ValueError):
        notification_text.premiere_reminder_notification(locale="en", kind="advance", advance="10min", creator_name="x", video_title="t")
    with pytest.raises(ValueError):
        notification_text.premiere_reminder_notification(locale="en", kind=notification_text.KIND_PREMIERE_ADVANCE, advance="at_start", creator_name="x", video_title="t")


# ============ independence from the livestream reminders and the four daily slots ============


def test_it_never_depends_on_the_four_daily_new_video_slots(world, monkeypatch):
    """No new-video creator switch, no activation and delivery windows nowhere near the Premiere: the reminder still goes out, and the slot path is never touched."""
    world.add_client("c2", preference=_preference_value(deliveryWindows=["03:00"], newVideoCreatorOverride={}, newVideoActivatedAt={}))
    _choose(world, "at_start", client="c2")
    monkeypatch.setattr(notification_dispatcher.new_video_dispatcher, "run", lambda *a, **kw: (_ for _ in ()).throw(AssertionError("the slot dispatcher must not run")))

    summary = world.run(START + timedelta(seconds=10))

    assert summary["delivered"] == 0  # the livestream counters are untouched ...
    assert summary["premiere"] == {"checked": 1, "delivered": 1, "unserved": 0}  # ... the Premiere step is reported on its own
    assert [push["endpoint"] for push in world.pushes] == ["https://push.example/c2"]


def test_a_premiere_is_never_routed_through_livestream_eligibility(world):
    """The client follows the creator for livestreams (creator 全部 = at start). The Premiere is not a livestream: it gets only its own Premiere reminder."""
    world.add_client("c1", creator_reminders={"aizawa_ema": AT_START})
    world.add_client("c3", creator_reminders={"aizawa_ema": AT_START})  # follows the creator but chose no Premiere reminder
    _choose(world, "at_start", client="c1")

    world.run(START + timedelta(seconds=10))

    sent = {push["endpoint"].rsplit("/", 1)[1]: push["data"]["reminderKind"] for push in world.pushes}
    assert sent == {"c1": "premiere_start"}  # c3, a livestream follower, receives nothing for the Premiere
    schedule = world.config[(live_reminder.SYSTEM_CLIENT_ID, live_reminder.STREAM_SCHEDULE_KEY)]
    assert "p1" not in schedule["entries"]  # never a livestream entry: no creator / topic reminder, no simultaneous-notice collision
    assert list(schedule[premiere_reminder.PREMIERES_FIELD]) == ["p1"]


def test_a_stored_premiere_reminder_is_not_a_livestream_override(world):
    """The key namespace is its own: the livestream resolver never sees the item, so it can never become a stream-start reminder."""
    _choose(world, "at_start")
    items = [key for (_client, key) in world.config if key.startswith(live_reminder.STREAM_OVERRIDE_KEY_PREFIX)]
    assert items == []
    assert premiere_reminder.premiere_reminder_key("p1") != live_reminder.stream_override_key("p1")
    assert not premiere_reminder.PREMIERE_REMINDER_KEY_PREFIX.startswith(live_reminder.STREAM_OVERRIDE_KEY_PREFIX)


def test_an_ordinary_livestream_reminder_is_unchanged_next_to_a_premiere_reminder(world):
    """A livestream and a Premiere due at the same minute each get their own notification of their own kind."""
    world.add_client("c1", creator_reminders={"aizawa_ema": AT_START})
    world.refresh_snapshot([_stream("live1"), _premiere()], SNAPSHOT_AT)
    _choose(world, "at_start")

    world.run(START + timedelta(seconds=10))

    assert sorted((push["data"]["videoId"], push["data"]["reminderKind"]) for push in world.pushes) == [("live1", "start"), ("p1", "premiere_start")]


def test_it_does_not_replace_the_automatic_announcement_or_the_archive_notification(world):
    """The delivery-log rows of the automatic announcement (plain id) and of the archive phase ('#premiere_archived') are different ids from the
    reminder's, so neither suppresses the other: the reminder is sent although both rows exist, and it never writes either id."""
    world.delivery[("c1", "p1")] = {"status": "delivered", "at": "2026-10-17T00:00:00+00:00"}
    world.delivery[("c1", "p1#premiere_archived")] = {"status": "delivered", "at": "2026-10-17T00:00:00+00:00"}
    _choose(world, "at_start")

    world.run(START + timedelta(seconds=10))

    assert len(world.pushes) == 1
    assert world.delivery[("c1", "p1")]["at"] == "2026-10-17T00:00:00+00:00"
    assert world.delivery[("c1", "p1#premiere_archived")]["at"] == "2026-10-17T00:00:00+00:00"
    start_minute = int(START.timestamp() * 1000) // 60_000
    reminder_ids = [video for (_client, video) in world.delivery if ":reminder:" in video]
    assert reminder_ids == [f"p1:reminder:premiere_start@{start_minute}"]
    # ... and an automatic announcement or archive row can never be mistaken for a reminder row, nor the reverse
    assert f"p1:reminder:premiere_start@{start_minute}" not in ("p1", "p1#premiere_archived")
    assert notification_dispatcher._reminder_dedupe_ids("p1", "premiere_advance", 1)[0] != notification_dispatcher._reminder_dedupe_ids("p1", "advance", 1)[0]


# ============ once only: delivery, cancellation, staleness ============


def test_a_delivered_reminder_is_consumed_and_never_sent_again(world):
    _choose(world, "at_start")

    assert world.run(START + timedelta(seconds=10))["premiere"]["delivered"] == 1

    assert _stored(world) is None  # no longer eligible: the stored reminder is consumed by the confirmed delivery
    assert world.run(START + timedelta(seconds=20)).get("premiere") is None
    assert len(world.pushes) == 1


def test_if_consuming_fails_the_delivery_row_still_prevents_a_second_send(world, monkeypatch):
    """The push is out and its row is permanent; an item that could not be deleted stays inert and sends nothing in the same minute again."""
    _choose(world, "at_start")
    monkeypatch.setattr(remote_config_store, "delete_remote_config", lambda client_id, key: (_ for _ in ()).throw(RuntimeError("store down")))

    world.run(START + timedelta(seconds=10))
    world.run(START + timedelta(seconds=30))

    assert len(world.pushes) == 1
    assert _stored(world) is not None


def test_overlapping_runs_never_send_twice(world):
    """Two runs that both pass the pre-check: the atomic claim lets only one of them send."""
    _choose(world, "at_start")
    world.blind_precheck = True

    world.run(START + timedelta(seconds=5))
    _choose(world, "at_start")  # the (slower) second run still sees the item
    world.run(START + timedelta(seconds=15))

    assert len(world.pushes) == 1


def test_a_failed_send_releases_the_claim_so_a_retry_inside_the_window_delivers_once(world):
    from notifications.push_sender import PushResult

    _choose(world, "at_start")
    world.push_results = [PushResult(sent=False, subscription_expired=False, error="boom", retryable=False)]

    world.run(START + timedelta(seconds=5))
    assert _stored(world) is not None  # not consumed: nothing was delivered
    world.run(START + timedelta(seconds=20))

    assert [push["sent"] for push in world.pushes] == [False, True]
    assert _stored(world) is None


def test_cancelling_before_the_moment_means_nothing_is_sent(world):
    _choose(world, "10min")
    del world.config[("c1", premiere_reminder.premiere_reminder_key("p1"))]  # DELETE /clients/{id}/premiere-reminder/{videoId}

    for minute in range(-70, 10):
        world.run(START + timedelta(minutes=minute, seconds=10))

    assert world.pushes == []


def test_a_premiere_that_disappears_from_the_snapshot_before_its_start_loses_its_reminder(world):
    """Cancelled or deleted: the next derivation drops the Premiere's schedule entry, so the stored reminder can no longer fire."""
    _choose(world, "10min")
    world.run(START - timedelta(minutes=14))  # the schedule is derived (snapshot of :00) while the Premiere is listed
    world.refresh_snapshot([], START - timedelta(minutes=13))  # a newer snapshot without it

    world.run(_target("10min") + timedelta(seconds=10))

    assert world.pushes == []
    assert world.config[(live_reminder.SYSTEM_CLIENT_ID, live_reminder.STREAM_SCHEDULE_KEY)][premiere_reminder.PREMIERES_FIELD] == {}
    assert _stored(world) is not None  # the item is inert, not deleted: the Premiere may be listed again


def test_a_missed_minute_is_not_replayed_late_without_recovery(world):
    """Recovery is off in these tests (like the dispatcher's own): a run three minutes after the chosen time finds nothing due."""
    _choose(world, "10min")

    assert world.run(_target("10min") + timedelta(minutes=3))["delivered"] == 0
    assert world.pushes == []


@pytest.fixture
def recovery(monkeypatch):
    """The dispatcher's real recovery of unserved minutes (switched off by default in these tests)."""
    monkeypatch.setattr(notification_dispatcher, "_MAX_RECOVERY_LOOKBACK", timedelta(minutes=10))


def test_a_recovered_advance_reminder_names_the_real_time_left(world, recovery):
    _choose(world, "10min")
    world.run(_target("10min") - timedelta(seconds=60))  # served; the next run is late by 2.5 minutes

    world.run(_target("10min") + timedelta(seconds=150))

    assert len(world.pushes) == 1
    assert world.pushes[0]["data"]["reminderKind"] == "premiere_advance"
    assert "about 8 minutes" in world.pushes[0]["title"] or "約 8 分鐘" in world.pushes[0]["title"] or "約8分後" in world.pushes[0]["title"]


def test_a_recovered_advance_reminder_is_dropped_once_the_start_is_too_close(world, recovery):
    """A stored legacy 1-minute reminder: a run that serves the minute late, after the 2-minute limit, sends nothing -- a stale 'in 1 minute' is never delivered."""
    _choose(world, "1min")
    world.run(_target("1min") - timedelta(seconds=60))

    world.run(START + timedelta(seconds=45))

    assert world.pushes == []


def test_a_reminder_saved_after_its_moment_is_never_replayed(world, recovery, monkeypatch):
    """Turning the reminder on after the moment already came due sends nothing retroactively (the recovery rule: saved before the fire time)."""
    _choose(world, "10min")
    saved_late = {"clientId": "c1", "key": premiere_reminder.premiere_reminder_key("p1"), "value": world.config[("c1", premiere_reminder.premiere_reminder_key("p1"))], "updatedAt": (_target("10min") + timedelta(seconds=30)).isoformat()}
    monkeypatch.setattr(world, "_list_by_key", lambda key: [saved_late] if key == saved_late["key"] else [])
    monkeypatch.setattr(remote_config_store, "list_by_key", world._list_by_key)
    world.run(_target("10min") - timedelta(seconds=60))

    world.run(_target("10min") + timedelta(seconds=150))

    assert world.pushes == []


# ============ schedule changes and reclassification ============


def test_a_rescheduled_premiere_moves_the_reminder_with_it(world):
    _choose(world, "10min")
    world.run(_target("10min") - timedelta(minutes=5))  # derived at the original start
    new_start = START + timedelta(minutes=30)
    world.refresh_snapshot([_premiere(start=new_start)], _target("10min") - timedelta(minutes=2))

    world.run(_target("10min") + timedelta(seconds=10))  # the OLD moment: the stored schedule has moved on
    assert world.pushes == []
    world.run(_target("10min", new_start) + timedelta(seconds=10))

    assert len(world.pushes) == 1
    assert world.pushes[0]["data"]["reminderKind"] == "premiere_advance"


def test_after_a_delivered_reminder_a_reschedule_does_not_send_it_again_but_it_can_be_set_again(world):
    _choose(world, "at_start")
    world.run(START + timedelta(seconds=10))
    new_start = START + timedelta(hours=1)
    world.refresh_snapshot([_premiere(start=new_start)], START + timedelta(minutes=5))

    world.run(new_start + timedelta(seconds=10))
    assert len(world.pushes) == 1  # consumed: the one occurrence was already delivered

    _choose(world, "at_start")  # the user sets a new reminder for the new time ...
    world.refresh_snapshot([_premiere(start=new_start + timedelta(hours=1))], new_start + timedelta(minutes=5))
    world.run(new_start + timedelta(hours=1, seconds=10))
    assert len(world.pushes) == 2  # ... which is a new target (another start minute) and is delivered once


def test_a_premiere_relisted_as_an_ordinary_stream_never_becomes_a_livestream_reminder(world):
    """Reclassified: the id is now an ordinary upcoming stream. The Premiere reminder neither fires nor turns into a stream-start reminder."""
    _choose(world, "at_start")
    world.run(START - timedelta(minutes=14))
    world.refresh_snapshot([_premiere(status="upcoming")], START - timedelta(minutes=13))

    world.run(START + timedelta(seconds=10))

    assert world.pushes == []  # no creator reminder or override exists, so the ordinary stream notifies nobody
    schedule = world.config[(live_reminder.SYSTEM_CLIENT_ID, live_reminder.STREAM_SCHEDULE_KEY)]
    assert "p1" in schedule["entries"] and schedule[premiere_reminder.PREMIERES_FIELD] == {}


def test_a_premiere_the_snapshot_relabels_as_live_at_its_start_still_gets_its_at_start_reminder(world):
    """At the scheduled start the snapshot may list the airing Premiere as 'live': the started entry is carried forward just long enough."""
    _choose(world, "at_start")
    world.run(START - timedelta(minutes=5))
    world.refresh_snapshot([_stream("p1", start=START, status="live", actual=START)], START + timedelta(seconds=5))

    world.run(START + timedelta(seconds=10))

    assert [push["data"]["reminderKind"] for push in world.pushes] == ["premiere_start"]


def test_a_started_premiere_is_dropped_from_the_schedule_after_the_carry_forward(world):
    world.run(START - timedelta(minutes=5))
    world.refresh_snapshot([_stream("p1", start=START, status="live", actual=START)], START + timedelta(minutes=20))

    world.run(START + timedelta(minutes=21))

    assert world.config[(live_reminder.SYSTEM_CLIENT_ID, live_reminder.STREAM_SCHEDULE_KEY)][premiere_reminder.PREMIERES_FIELD] == {}


# ============ suppression, recipients ============


def test_the_master_switch_the_creator_switch_mute_and_quiet_hours_suppress_it(world):
    world.add_client("off", preference=_preference_value(enabled=False))
    world.add_client("creator-off", preference=_preference_value(creatorOverride={"aizawa_ema": False}))
    world.add_client("muted", preference=_preference_value(temporaryMute=(START + timedelta(hours=2)).isoformat()))
    world.add_client("quiet", preference=_preference_value(quietHours=["21:00", "22:00"]))  # 21:15 JST is inside
    world.add_client("nosub", subscribed=False)
    for client in ("off", "creator-off", "muted", "quiet", "nosub", "c1"):
        _choose(world, "at_start", client=client)

    world.run(START + timedelta(seconds=10))

    assert [push["endpoint"] for push in world.pushes] == ["https://push.example/c1"]


def test_each_client_gets_its_own_choice_at_its_own_moment(world):
    world.add_client("c2")
    _choose(world, "30min", client="c1")
    _choose(world, "at_start", client="c2")

    world.run(_target("30min") + timedelta(seconds=10))
    assert [push["endpoint"] for push in world.pushes] == ["https://push.example/c1"]
    world.run(START + timedelta(seconds=10))

    assert [push["endpoint"] for push in world.pushes] == ["https://push.example/c1", "https://push.example/c2"]


# ============ cost: nothing is read unless a Premiere reminder minute is due ============


def test_an_idle_minute_reads_nothing_and_a_due_minute_costs_one_index_query_per_due_premiere(world, monkeypatch):
    _choose(world, "10min")
    calls: list[str] = []
    original = world._list_by_key
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: (calls.append(key), original(key))[1])

    world.run(START - timedelta(minutes=20))  # none of the five moments
    assert calls == []

    world.run(_target("10min") + timedelta(seconds=10))
    assert calls == [premiere_reminder.premiere_reminder_key("p1")]


def test_the_premiere_schedule_rides_in_the_existing_record_with_no_extra_read(world, monkeypatch):
    """Only the system streamSchedule record is read for the schedule (as before); the Premiere entries are part of it."""
    reads: list[str] = []
    original = remote_config_store.get_remote_config
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: (reads.append(key), original(client_id, key))[1])

    world.run(START - timedelta(minutes=20))

    assert reads.count(live_reminder.STREAM_SCHEDULE_KEY) == 1
    assert not any(key.startswith(premiere_reminder.PREMIERE_REMINDER_KEY_PREFIX) for key in reads)


# ============ a failed Premiere step never moves the recovery marker ============


def _marker_ms(moment: datetime) -> int:
    """The epoch-millisecond value the dispatcher's recovery marker takes for a run whose own instant is `moment`."""
    return int(moment.timestamp() * 1000)


def test_a_failed_premiere_step_leaves_the_minute_for_recovery_and_the_next_run_delivers_it_once(world, recovery, monkeypatch):
    """A DynamoDB index-query failure while finding the holders of a due Premiere must not make the reminder vanish: the failure is swallowed (it never
    fails the livestream reminders) but the recovery marker stays put, so the next run serves the minute again and the reminder is delivered exactly once."""
    from stores.remote_config_store import RemoteConfigStoreError

    _choose(world, "10min")
    first_run = _target("10min") - timedelta(seconds=60)
    world.run(first_run)  # an ordinary served minute: the marker is now at this run's instant
    assert notification_dispatcher._last_served_ms == _marker_ms(first_run)

    original = world._list_by_key
    broken = {"on": True}

    def flaky(key):
        """The configKey-index Query of the Premiere reminder holders fails while `broken` is on; every other key is served normally."""
        if broken["on"] and key.startswith(premiere_reminder.PREMIERE_REMINDER_KEY_PREFIX):
            raise RemoteConfigStoreError("Failed to query YobiRemoteConfig by configKey: throttled")
        return original(key)

    monkeypatch.setattr(remote_config_store, "list_by_key", flaky)

    failed_run = _target("10min") + timedelta(seconds=10)
    world.run(failed_run)  # the due minute: the Premiere step fails as a whole

    assert world.pushes == []
    assert notification_dispatcher._last_served_ms == _marker_ms(first_run)  # NOT advanced past the failed minute
    assert _stored(world) is not None  # nothing was delivered, so nothing is consumed

    broken["on"] = False
    world.run(failed_run + timedelta(seconds=60))  # the next run recovers the minute that was never served

    assert [push["data"]["reminderKind"] for push in world.pushes] == ["premiere_advance"]
    assert notification_dispatcher._last_served_ms == _marker_ms(failed_run + timedelta(seconds=60))  # served completely now: the marker moves on
    assert _stored(world) is None

    world.run(failed_run + timedelta(seconds=120))
    assert len(world.pushes) == 1  # and never again


def test_a_failed_premiere_step_does_not_stop_a_livestream_reminder_in_the_same_minute(world, recovery, monkeypatch):
    """The Premiere step is separate: a livestream reminder due in the same run is still delivered, and its own claim stops the recovery from re-sending it."""
    from stores.remote_config_store import RemoteConfigStoreError

    world.add_client("c1", creator_reminders={"aizawa_ema": AT_START})
    world.refresh_snapshot([_stream("live1"), _premiere()], SNAPSHOT_AT)
    _choose(world, "at_start")
    world.run(START - timedelta(seconds=60))
    original = world._list_by_key

    def flaky(key):
        """Fails only for the Premiere holders' Query."""
        if key.startswith(premiere_reminder.PREMIERE_REMINDER_KEY_PREFIX):
            raise RemoteConfigStoreError("throttled")
        return original(key)

    monkeypatch.setattr(remote_config_store, "list_by_key", flaky)

    world.run(START + timedelta(seconds=10))
    assert [(push["data"]["videoId"], push["data"]["reminderKind"]) for push in world.pushes] == [("live1", "start")]  # the livestream reminder went out
    assert notification_dispatcher._last_served_ms == _marker_ms(START - timedelta(seconds=60))  # the Premiere minute stays recoverable

    monkeypatch.setattr(remote_config_store, "list_by_key", original)
    world.run(START + timedelta(seconds=70))

    assert sorted((push["data"]["videoId"], push["data"]["reminderKind"]) for push in world.pushes) == [("live1", "start"), ("p1", "premiere_start")]


def test_recovery_after_a_partly_served_run_never_sends_a_reminder_twice(world, recovery, monkeypatch):
    """The first instant of a run delivers, the Premiere step then fails on the second one: the next run re-serves the first instant, but the delivery
    row claimed by the first send stops a second push -- even when the delivered reminder could not be consumed (deleted)."""
    _choose(world, "10min")
    first_run = _target("10min") - timedelta(seconds=60)
    world.run(first_run)
    monkeypatch.setattr(remote_config_store, "delete_remote_config", lambda client_id, key: (_ for _ in ()).throw(RuntimeError("store down")))  # never consumed
    original_due = premiere_reminder.due_entries
    calls = {"count": 0}

    def due_then_fail(entries, *, now_ms, window_ms):
        """The second instant of the first recovering run raises, as a store or runtime error in the middle of the step would."""
        calls["count"] += 1
        if calls["count"] == 2:
            raise RuntimeError("failure after the first instant was served")
        return original_due(entries, now_ms=now_ms, window_ms=window_ms)

    monkeypatch.setattr(premiere_reminder, "due_entries", due_then_fail)

    world.run(_target("10min") + timedelta(seconds=150))  # instants: the missed fire minute (delivers), then the failing one
    assert len(world.pushes) == 1
    assert notification_dispatcher._last_served_ms == _marker_ms(first_run)  # the failed step kept the gap

    world.run(_target("10min") + timedelta(seconds=210))  # recovers the same minutes again

    assert len(world.pushes) == 1  # no duplicate: the claim of the first delivery holds
    assert _stored(world) is not None  # the unconsumed item is inert


# ============ the pure rules ============


def test_the_five_choices_and_their_offsets_are_exactly_the_schedule_controls():
    assert premiere_reminder.REMINDER_VALUES == CHOICES
    assert "1min" not in premiere_reminder.REMINDER_VALUES and premiere_reminder.LEGACY_REMINDER_VALUES == ("1min",)
    assert premiere_reminder.REMINDER_OFFSET_MINUTES == OFFSET  # every offset a stored item can hold, the retired 1 minute included


def test_the_retired_one_minute_choice_is_refused_when_saving_but_read_when_stored():
    with pytest.raises(live_reminder.ClientError):
        premiere_reminder.parse_premiere_reminder({"creatorId": "aizawa_ema", "reminder": "1min"})
    assert premiere_reminder.parse_premiere_reminder({"creatorId": "aizawa_ema", "reminder": "1min"}, allow_legacy=True).reminder == "1min"
    with pytest.raises(live_reminder.ClientError):  # the legacy allowance covers 1 minute only
        premiere_reminder.parse_premiere_reminder({"creatorId": "aizawa_ema", "reminder": "5min"}, allow_legacy=True)


def test_a_stored_legacy_one_minute_reminder_is_still_delivered_once_and_then_consumed(world):
    """Existing behavior is preserved for a reminder saved before the choice was retired: it is not converted to another time and not ignored."""
    _choose(world, "1min")

    assert world.run(_target("10min") + timedelta(seconds=10))["delivered"] == 0  # never at another time
    world.run(_target("1min") + timedelta(seconds=10))

    assert [push["data"]["reminderKind"] for push in world.pushes] == ["premiere_advance"]
    assert "1 minute" in world.pushes[0]["title"] or "1 分鐘" in world.pushes[0]["title"] or "1分後" in world.pushes[0]["title"]
    assert _stored(world) is None
    world.run(START + timedelta(seconds=10))
    assert len(world.pushes) == 1


def test_the_due_minute_of_a_stored_legacy_one_minute_reminder_is_still_found():
    start_ms = 1_000_000_000_000
    entries = {"p1": premiere_reminder.PremiereEntry("aizawa_ema", start_ms)}
    assert premiere_reminder.due_entries(entries, now_ms=start_ms - 60_000, window_ms=60_000) == entries
    assert premiere_reminder.due_entries(entries, now_ms=start_ms - 120_000, window_ms=60_000) == {}


def test_parse_premiere_reminder_accepts_one_choice_and_a_creator_only():
    assert premiere_reminder.parse_premiere_reminder({"creatorId": "aizawa_ema", "reminder": "30min"}).reminder == "30min"
    for bad in (None, [], {"creatorId": "x"}, {"reminder": "10min"}, {"creatorId": "x", "reminder": "off"}, {"creatorId": "x", "reminder": ["10min"]}, {"creatorId": "", "reminder": "10min"}):
        with pytest.raises(live_reminder.ClientError):
            premiere_reminder.parse_premiere_reminder(bad)


def test_the_window_is_never_early_and_is_one_minute_wide():
    start = 1_000_000_000_000
    fire = premiere_reminder.fire_at_ms("10min", start)
    assert not premiere_reminder.is_due("10min", start, now_ms=fire - 1, window_ms=60_000)
    assert premiere_reminder.is_due("10min", start, now_ms=fire, window_ms=60_000)
    assert premiere_reminder.is_due("10min", start, now_ms=fire + 59_999, window_ms=60_000)
    assert not premiere_reminder.is_due("10min", start, now_ms=fire + 60_000, window_ms=60_000)


def test_derive_entries_keeps_only_premieres_and_carries_a_started_one_for_a_limited_time():
    now_ms = int(START.timestamp() * 1000)
    streams = [_premiere("p1"), _stream("live1"), _premiere("bad", start=START).copy() | {"scheduledStart": None}]
    entries = premiere_reminder.derive_entries(streams, previous={}, now_ms=now_ms)
    assert set(entries) == {"p1"} and entries["p1"].scheduled_start_ms == now_ms and entries["p1"].creator_id == "aizawa_ema"

    # not listed any more, not started yet -> cancelled; started and within the carry-forward -> kept; past it -> dropped
    previous = {
        "future": premiere_reminder.PremiereEntry("aizawa_ema", now_ms + 60_000),
        "airing": premiere_reminder.PremiereEntry("aizawa_ema", now_ms - 60_000),
        "old": premiere_reminder.PremiereEntry("aizawa_ema", now_ms - premiere_reminder.CARRY_FORWARD_AFTER_START_MS - 1),
    }
    kept = premiere_reminder.derive_entries([], previous=previous, now_ms=now_ms)
    assert set(kept) == {"airing"}


def test_entries_round_trip_and_a_damaged_entry_only_loses_itself():
    entries = {"p1": premiere_reminder.PremiereEntry("aizawa_ema", 123_000, "title"), "p2": premiere_reminder.PremiereEntry("aizawa_ema", 456_000)}
    assert premiere_reminder.parse_entries(premiere_reminder.entries_to_value(entries)) == entries
    damaged = {"p1": {"creatorId": "aizawa_ema", "scheduledStartMs": 1000}, "p2": {"creatorId": "", "scheduledStartMs": 1}, "p3": "x", "p4": {"creatorId": "a", "scheduledStartMs": True}}
    assert set(premiere_reminder.parse_entries(damaged)) == {"p1"}
    assert premiere_reminder.parse_entries(None) == {} and premiere_reminder.parse_entries([]) == {}
