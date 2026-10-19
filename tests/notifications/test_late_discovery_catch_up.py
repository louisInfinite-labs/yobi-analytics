"""Late-discovery catch-up for advance reminders (docs/late-discovery-advance-catch-up.md).

The incident this exists for: a 30-minute reminder for a 22:00 JST stream that was created at 21:36 JST and first reached the dispatcher's data at
21:50 JST -- after its 21:30 fire time -- so the on-time window ([fire_at, fire_at + 1 min)) could never serve it.

End to end through notification_dispatcher.lambda_handler on the same in-memory world the scheduled-start tests use (nothing here can reach Holodex),
extended with per-record saved-at times, the kill switch record, and the earlier-reminder lookup. Pure rules are tested directly.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from notifications import live_reminder, notification_dispatcher, notification_text
from notifications.push_sender import PushResult
from stores import notification_delivery_log_store
from tests.notifications.test_notification_dispatcher import _preference_value
from tests.notifications.test_scheduled_start_notifications import Harness, _stream

UTC = timezone.utc
SYSTEM = live_reminder.SYSTEM_CLIENT_ID
FLAG = live_reminder.CATCH_UP_FLAG_KEY
SCHEDULE = live_reminder.STREAM_SCHEDULE_KEY

START = datetime(2026, 10, 18, 13, 0, 0, tzinfo=UTC)  # 22:00 JST
START_MINUTE = int(START.timestamp()) // 60
F30 = START - timedelta(minutes=30)  # 21:30 JST, the 30-minute reminder's fire time
F10 = START - timedelta(minutes=10)
SNAP_EMPTY = datetime(2026, 10, 18, 12, 40, 7, tzinfo=UTC)  # the 21:40 snapshot, which does not have the stream yet
SNAP_FOUND = datetime(2026, 10, 18, 12, 50, 7, tzinfo=UTC)  # the 21:50 snapshot, the first to have it
RUN_AFTER = datetime(2026, 10, 18, 12, 51, 4, tzinfo=UTC)  # the dispatcher run right after
OLD = "2026-10-10T00:00:00+00:00"  # a settings / subscription save long before everything here
ADV30 = {"notifyAtStart": True, "advanceReminder": "30min"}
ADV10 = {"notifyAtStart": True, "advanceReminder": "10min"}
ADV60 = {"notifyAtStart": True, "advanceReminder": "1hour"}
ADV1 = {"notifyAtStart": True, "advanceReminder": "1min"}
AT_START_ONLY = {"notifyAtStart": True, "advanceReminder": None}
ON = {"enabled": True}
CREATOR_KEY = live_reminder.creator_reminder_key("aizawa_ema", "all")
SUBSCRIPTION_KEY = notification_dispatcher._PUSH_SUBSCRIPTION_KEY


def _ms(moment: datetime) -> int:
    """A datetime as epoch milliseconds."""
    return int(moment.timestamp() * 1000)


def _minute_id(video_id: str, kind: str, start: datetime) -> str:
    """The dedupe id the dispatcher uses for one reminder kind of one stream at one scheduled start."""
    return f"{video_id}:reminder:{kind}@{int(start.timestamp()) // 60}"


class CatchUpHarness(Harness):
    """The scheduled-start world plus what the catch-up needs: saved-at times per stored record, the kill switch, the earlier-reminder lookup."""

    def __init__(self, monkeypatch):
        """Wire the extra boundaries on top of the base world."""
        super().__init__(monkeypatch)
        self.saved_at: dict[tuple[str, str], str | None] = {}  # (client, key) -> updatedAt; absent = OLD; None = the record carries no updatedAt
        self.flag_error: Exception | None = None
        self.handled_error: Exception | None = None
        self.events: list[str] = []  # "flag" / "handled": the order the catch-up asked its questions in
        self.handled_calls: list[set[str]] = []
        monkeypatch.setattr(notification_delivery_log_store, "handled_ids", self._handled_ids)

    def _updated(self, client_id: str, key: str) -> str | None:
        """The updatedAt a stored record carries (OLD unless a test set one; None means the record has none)."""
        return self.saved_at.get((client_id, key), OLD)

    def _get_config(self, client_id, key):
        """remote_config_store.get_remote_config, with a per-record updatedAt and the kill switch's read counted."""
        if (client_id, key) == (SYSTEM, FLAG):
            self.events.append("flag")
            if self.flag_error is not None:
                raise self.flag_error
        value = self.config.get((client_id, key))
        if value is None:
            return None
        record = {"clientId": client_id, "key": key, "value": value}
        updated = self._updated(client_id, key)
        if updated is not None:
            record["updatedAt"] = updated
        return record

    def _list_by_prefix(self, client_id, prefix):
        """remote_config_store.list_remote_config_by_prefix, each record with its own updatedAt."""
        records = []
        for (client, key), value in self.config.items():
            if client == client_id and key.startswith(prefix):
                record = {"clientId": client, "key": key, "value": value}
                updated = self._updated(client, key)
                if updated is not None:
                    record["updatedAt"] = updated
                records.append(record)
        return records

    def _handled_ids(self, client_id, ids, *, now=None):
        """notification_delivery_log_store.handled_ids over the in-memory log (a claim or a delivery counts)."""
        self.events.append("handled")
        self.handled_calls.append(set(ids))
        if self.handled_error is not None:
            raise self.handled_error
        return {video_id for video_id in ids if (client_id, video_id) in self.delivery}

    @property
    def flag_reads(self) -> int:
        """How many times the kill switch record was read."""
        return self.events.count("flag")

    def catch_up_titles(self) -> list[str]:
        """The titles of every catch-up push that went out (they are the only ones saying "about N minutes")."""
        return [title for title in self.titles() if "about" in title]


def make_world(monkeypatch, *, setting=ADV30, flag=ON, preference=None, found_at=SNAP_FOUND, stream=None) -> CatchUpHarness:
    """A tracked schedule exists first (empty snapshot at 21:40 JST), then the snapshot at `found_at` carries the stream for the first time."""
    world = CatchUpHarness(monkeypatch)
    world.add_client("c1", preference=preference, creator_reminders={"aizawa_ema": setting})
    if flag is not None:
        world.config[(SYSTEM, FLAG)] = flag
    world.refresh_snapshot([], SNAP_EMPTY)
    world.run(SNAP_EMPTY + timedelta(seconds=58))
    world.refresh_snapshot([stream or _stream(start=START)], found_at)
    return world


def seed_schedule(world: CatchUpHarness, *, start=START, first_seen_at=SNAP_FOUND, prior=(), status="upcoming", start_minute=None) -> None:
    """Write the persisted schedule record directly (as already derived from the current snapshot), so a test can decide exactly what the dispatcher
    knows without going through a derivation."""
    source = world.snapshot_at
    world.snapshot = [_stream(start=start)]
    world.config[(SYSTEM, SCHEDULE)] = {
        "entries": {"v1": {"creatorId": "aizawa_ema", "scheduledStartMs": _ms(start), "topic": None, "title": "Ranked grind", "status": status}},
        "refreshedAt": source.isoformat(),
        "sourceRefreshedAt": source.isoformat(),
        "firstSeen": {
            "v1": {
                "startMinute": start_minute if start_minute is not None else int(start.timestamp()) // 60,
                "firstSeenAt": first_seen_at.isoformat() if first_seen_at else None,
                "priorStartMinutes": list(prior),
            }
        },
    }


def seeded_world(monkeypatch, **kwargs) -> CatchUpHarness:
    """A world with one client and a ready-made schedule record; keyword arguments go to seed_schedule, plus setting / flag / preference."""
    options = {key: kwargs.pop(key) for key in ("setting", "flag", "preference") if key in kwargs}
    world = CatchUpHarness(monkeypatch)
    world.add_client("c1", preference=options.get("preference"), creator_reminders={"aizawa_ema": options.get("setting", ADV30)})
    flag = options.get("flag", ON)
    if flag is not None:
        world.config[(SYSTEM, FLAG)] = flag
    world.snapshot_at = SNAP_FOUND
    seed_schedule(world, **kwargs)
    return world


# ============ the incident ============


def test_the_incident_replay_a_30_minute_reminder_for_a_stream_created_after_its_fire_time_is_sent_with_the_actual_minutes_left(monkeypatch):
    """Created 21:36 JST for 22:00, in the 21:50 snapshot, derived by the 21:51:04 run: 8 min 56 s left -> "about 9 minutes", once."""
    world = make_world(monkeypatch)

    assert world.run(RUN_AFTER)["delivered"] == 1

    assert len(world.pushes) == 1
    assert world.pushes[0]["title"].endswith("goes live in about 9 minutes")
    assert world.pushes[0]["data"] == {"videoId": "v1", "reminderKind": "advance", "url": "/creator/aizawa-ema"}
    assert world.delivery[("c1", _minute_id("v1", "advance", START))]["status"] == "delivered"


def test_a_10_minute_reminder_missed_by_seconds_is_caught_up_too(monkeypatch):
    """The 10-minute fire time was 21:50:00; the schedule was derived at 21:51:04 -- 4 seconds after the on-time window closed."""
    world = make_world(monkeypatch, setting=ADV10)

    world.run(RUN_AFTER)

    assert [title.endswith("goes live in about 9 minutes") for title in world.titles()] == [True]


def test_a_discovery_inside_the_on_time_window_is_served_by_the_on_time_path_and_the_catch_up_never_adds_a_second_one(monkeypatch):
    """A discovery inside the on time window is served by the on time path and the catch up never adds a second one."""
    world = make_world(monkeypatch, setting=ADV10)

    world.run(F10 + timedelta(seconds=30))  # derives the stream and is still inside [21:50:00, 21:51:00)
    world.run(RUN_AFTER)
    world.run(RUN_AFTER + timedelta(minutes=1))

    assert len(world.pushes) == 1
    assert world.pushes[0]["title"].endswith("goes live in 10 minutes")  # the on-time wording, not "about"


def test_the_catch_up_names_the_actual_minutes_left_not_the_configured_offset(monkeypatch):
    """The catch up names the actual minutes left not the configured offset."""
    found = datetime(2026, 10, 18, 12, 35, 7, tzinfo=UTC)  # 25 minutes before the start: the 1-hour fire time (12:00) is long past
    world = seeded_world(monkeypatch, setting=ADV60, first_seen_at=found)

    world.run(datetime(2026, 10, 18, 12, 36, 4, tzinfo=UTC))

    assert world.titles()[0].endswith("goes live in about 24 minutes")  # 1 hour was configured; 23 min 56 s are left


def test_it_works_through_the_real_derivation_and_a_localized_title(monkeypatch):
    """Not seeded: discovery stamps the stream, the next run sends, in the client's own language."""
    world = make_world(monkeypatch, preference=_preference_value(notificationLocale="zh-TW"))

    world.run(RUN_AFTER)

    assert world.titles() == ["藍沢エマ 將於約 9 分鐘後開播"]
    assert world.pushes[0]["body"] == "Ranked grind"


def test_a_repeat_in_the_following_minutes_sends_nothing_more(monkeypatch):
    """A repeat in the following minutes sends nothing more."""
    world = make_world(monkeypatch)

    for minutes in range(0, 8):
        world.run(RUN_AFTER + timedelta(minutes=minutes))

    assert len(world.catch_up_titles()) == 1


# ============ nothing is backfilled: only a stream that was NOT known at its fire time qualifies ============


def test_a_stream_known_before_its_fire_time_is_never_caught_up_after_a_dispatcher_gap(monkeypatch):
    """A stream known before its fire time is never caught up after a dispatcher gap."""
    world = CatchUpHarness(monkeypatch)
    world.add_client("c1", creator_reminders={"aizawa_ema": ADV30})
    world.config[(SYSTEM, FLAG)] = ON
    world.refresh_snapshot([], datetime(2026, 10, 18, 12, 0, 7, tzinfo=UTC))
    world.run(datetime(2026, 10, 18, 12, 0, 58, tzinfo=UTC))
    world.refresh_snapshot([_stream(start=START)], datetime(2026, 10, 18, 12, 10, 7, tzinfo=UTC))
    world.run(datetime(2026, 10, 18, 12, 11, 4, tzinfo=UTC))  # known 20 minutes before its 30-minute fire time

    # the dispatcher then does not run until well after the on-time window
    world.run(datetime(2026, 10, 18, 12, 45, 4, tzinfo=UTC))
    world.run(datetime(2026, 10, 18, 12, 55, 4, tzinfo=UTC))

    assert world.pushes == []


@pytest.mark.parametrize("first_seen_at", [F30, F30 - timedelta(seconds=1), None], ids=["exactly-at-the-fire-time", "just-before", "unknown"])
def test_only_a_start_first_observed_strictly_after_the_fire_time_qualifies(monkeypatch, first_seen_at):
    """Only a start first observed strictly after the fire time qualifies."""
    world = seeded_world(monkeypatch, first_seen_at=first_seen_at)

    world.run(RUN_AFTER)

    assert world.pushes == []


def test_a_stamp_for_a_different_start_minute_says_nothing_about_the_current_start(monkeypatch):
    """A stamp for a different start minute says nothing about the current start."""
    world = seeded_world(monkeypatch, start_minute=START_MINUTE - 20)

    world.run(RUN_AFTER)

    assert world.pushes == []


# ============ the cutoff and the stream's status ============


@pytest.mark.parametrize(
    "seconds_before_start, sends",
    [(120, True), (121, True), (119, False), (60, False), (0, False), (-1, False)],
)
def test_the_cutoff_is_two_minutes_before_the_start_and_never_at_or_after_it(monkeypatch, seconds_before_start, sends):
    """The cutoff is two minutes before the start and never at or after it."""
    world = seeded_world(monkeypatch)

    world.run(START - timedelta(seconds=seconds_before_start))

    assert (len(world.catch_up_titles()) == 1) is sends


def test_the_last_minutes_say_about_two_and_the_rounding_is_to_the_nearest_minute():
    """The last minutes say about two and the rounding is to the nearest minute."""
    assert live_reminder.catch_up_remaining_minutes(_ms(START), _ms(START - timedelta(minutes=2))) == 2
    assert live_reminder.catch_up_remaining_minutes(_ms(START), _ms(START - timedelta(seconds=8 * 60 + 56))) == 9
    assert live_reminder.catch_up_remaining_minutes(_ms(START), _ms(START - timedelta(seconds=9 * 60 + 29))) == 9
    assert live_reminder.catch_up_remaining_minutes(_ms(START), _ms(START - timedelta(seconds=9 * 60 + 30))) == 10
    assert live_reminder.catch_up_remaining_minutes(_ms(START), _ms(START - timedelta(seconds=30))) == 2  # never below the cutoff's own two minutes


@pytest.mark.parametrize("status", ["live", "ended", None])
def test_only_a_still_upcoming_stream_gets_a_catch_up(monkeypatch, status):
    """Only a still upcoming stream gets a catch up."""
    world = seeded_world(monkeypatch, status=status)

    world.run(RUN_AFTER)

    assert world.pushes == []


def test_a_stream_discovered_after_its_start_gets_no_advance_catch_up_and_the_start_reminder_is_unchanged(monkeypatch):
    """A stream discovered after its start gets no advance catch up and the start reminder is unchanged."""
    world = make_world(monkeypatch, found_at=START + timedelta(minutes=5, seconds=7))

    world.run(START + timedelta(minutes=6, seconds=4))

    assert world.pushes == []  # the on-time start window [13:00, 13:01) was long gone, exactly as before this feature


def test_a_one_minute_reminder_can_never_be_caught_up(monkeypatch):
    """A one minute reminder can never be caught up."""
    world = seeded_world(monkeypatch, setting=ADV1)

    world.run(RUN_AFTER)

    assert world.pushes == []


def test_a_start_only_setting_has_nothing_to_catch_up(monkeypatch):
    """A start only setting has nothing to catch up."""
    world = seeded_world(monkeypatch, setting=AT_START_ONLY)

    world.run(RUN_AFTER)

    assert world.pushes == []


# ============ the start reminder stays independent ============


def test_the_start_reminder_still_goes_out_once_at_the_start_after_a_catch_up(monkeypatch):
    """The start reminder still goes out once at the start after a catch up."""
    world = make_world(monkeypatch)

    world.run(RUN_AFTER)
    world.run(START + timedelta(seconds=4))

    assert [title.endswith("goes live in about 9 minutes") for title in world.titles()] == [True, False]
    assert world.titles()[1].endswith("is scheduled to go live now")
    assert len(world.pushes) == 2


def test_the_catch_up_and_the_start_reminder_never_share_a_dedupe_id(monkeypatch):
    """The catch up and the start reminder never share a dedupe id."""
    world = make_world(monkeypatch)
    world.run(RUN_AFTER)
    world.run(START + timedelta(seconds=4))

    assert {video_id for (_client, video_id) in world.delivery} == {_minute_id("v1", "advance", START), _minute_id("v1", "start", START)}


def test_the_start_reminder_is_unaffected_when_the_catch_up_is_off(monkeypatch):
    """The start reminder is unaffected when the catch up is off."""
    world = make_world(monkeypatch, flag=None)

    world.run(RUN_AFTER)
    world.run(START + timedelta(seconds=4))

    assert [title.endswith("is scheduled to go live now") for title in world.titles()] == [True]


# ============ the earlier-reminder guard: a reschedule never turns the catch-up into a second advance reminder ============


def _prior_row(world: CatchUpHarness, video_id_suffix: str, status="delivered") -> None:
    """Seed a delivery-log row for an earlier (or legacy) advance reminder id of the stream v1."""
    world.delivery[("c1", f"v1:reminder:advance{video_id_suffix}")] = {"status": status, "at": "2026-10-18T12:30:04+00:00"}


def test_no_catch_up_when_an_advance_reminder_was_already_handled_for_an_earlier_start(monkeypatch):
    """The on-time 30-minute reminder for the 13:00 start went out; the stream is then moved to 13:10 and the new fire time is already past."""
    old_start = datetime(2026, 10, 18, 13, 0, 0, tzinfo=UTC)
    new_start = datetime(2026, 10, 18, 13, 10, 0, tzinfo=UTC)
    world = seeded_world(monkeypatch, start=new_start, prior=[int(old_start.timestamp()) // 60], first_seen_at=datetime(2026, 10, 18, 12, 45, 7, tzinfo=UTC))
    _prior_row(world, f"@{int(old_start.timestamp()) // 60}")

    world.run(datetime(2026, 10, 18, 12, 46, 4, tzinfo=UTC))

    assert world.pushes == []
    assert world.handled_calls == [{"v1:reminder:advance", f"v1:reminder:advance@{int(old_start.timestamp()) // 60}"}]


def test_a_reschedule_to_an_earlier_start_with_no_earlier_reminder_is_caught_up(monkeypatch):
    """A reschedule to an earlier start with no earlier reminder is caught up."""
    old_start = datetime(2026, 10, 18, 14, 0, 0, tzinfo=UTC)
    new_start = datetime(2026, 10, 18, 13, 10, 0, tzinfo=UTC)  # moved 50 minutes earlier; its 30-minute fire time (12:40) has passed
    world = seeded_world(monkeypatch, start=new_start, prior=[int(old_start.timestamp()) // 60], first_seen_at=datetime(2026, 10, 18, 12, 45, 7, tzinfo=UTC))

    world.run(datetime(2026, 10, 18, 12, 46, 4, tzinfo=UTC))

    assert world.titles()[0].endswith("goes live in about 24 minutes")


def test_a_legacy_advance_row_without_a_start_time_also_blocks_the_catch_up(monkeypatch):
    """A legacy advance row without a start time also blocks the catch up."""
    world = seeded_world(monkeypatch)
    _prior_row(world, "")

    world.run(RUN_AFTER)

    assert world.pushes == []


def test_a_live_claim_for_an_earlier_start_counts_as_handled(monkeypatch):
    """A live claim for an earlier start counts as handled."""
    earlier = datetime(2026, 10, 18, 12, 59, 0, tzinfo=UTC)
    world = seeded_world(monkeypatch, prior=[int(earlier.timestamp()) // 60])
    _prior_row(world, f"@{int(earlier.timestamp()) // 60}", status="claimed")

    world.run(RUN_AFTER)

    assert world.pushes == []


def test_an_advance_reminder_already_delivered_for_the_current_start_is_never_repeated_by_the_catch_up(monkeypatch):
    """The catch-up shares the on-time reminder's dedupe id for this start: the shared claim refuses it."""
    world = seeded_world(monkeypatch)
    world.delivery[("c1", _minute_id("v1", "advance", START))] = {"status": "delivered", "at": "2026-10-18T12:30:04+00:00"}

    world.run(RUN_AFTER)

    assert world.pushes == []


def test_a_rescheduled_stream_the_on_time_path_still_behaves_exactly_as_before(monkeypatch):
    """Per-target dedupe is unchanged: a stream moved LATER and known at its new fire time gets its on-time reminder again at the new time."""
    world = seeded_world(monkeypatch, first_seen_at=datetime(2026, 10, 18, 11, 0, 7, tzinfo=UTC))
    world.delivery[("c1", f"v1:reminder:advance@{START_MINUTE - 60}")] = {"status": "delivered", "at": "2026-10-18T11:30:04+00:00"}

    world.run(F30 + timedelta(seconds=4))

    assert [title.endswith("goes live in 30 minutes") for title in world.titles()] == [True]


# ---- the documented limit: only the last 8 earlier start minutes are remembered ----


def _eight_prior_minutes() -> list[int]:
    """Eight distinct earlier start minutes, the most a FirstSeen remembers."""
    return [START_MINUTE - 100 + step for step in range(8)]


@pytest.mark.parametrize("which", [0, 7], ids=["the-oldest-kept", "the-newest-kept"])
def test_every_one_of_the_eight_remembered_earlier_starts_blocks_the_catch_up(monkeypatch, which):
    """Every one of the eight remembered earlier starts blocks the catch up."""
    prior = _eight_prior_minutes()
    world = seeded_world(monkeypatch, prior=prior)
    _prior_row(world, f"@{prior[which]}")

    world.run(RUN_AFTER)

    assert world.pushes == []
    assert world.handled_calls == [{"v1:reminder:advance", *{f"v1:reminder:advance@{m}" for m in prior}}]


def test_the_limit_an_advance_reminder_for_a_start_older_than_the_eight_remembered_is_not_found(monkeypatch):
    """DOCUMENTED LIMITATION: a ninth, forgotten start's delivered reminder cannot block the catch-up (the guard only knows the last eight)."""
    prior = _eight_prior_minutes()
    forgotten = prior[0] - 1
    world = seeded_world(monkeypatch, prior=prior)
    _prior_row(world, f"@{forgotten}")

    world.run(RUN_AFTER)

    assert len(world.catch_up_titles()) == 1
    assert f"v1:reminder:advance@{forgotten}" not in world.handled_calls[0]


def test_a_stream_rescheduled_ten_times_remembers_exactly_the_last_eight_earlier_starts():
    """A stream rescheduled ten times remembers exactly the last eight earlier starts."""
    observed = datetime(2026, 10, 18, 10, 0, 7, tzinfo=UTC)
    previous = _snapshot({}, stamps={}, source=observed)
    start = 1_792_000_000_000
    first = live_reminder.derive_first_seen(
        previous=previous, entries={"v1": {"scheduledStartMs": start}}, observed_at=observed + timedelta(minutes=10), now=observed, max_source_gap=timedelta(minutes=21)
    )
    minutes = [start // 60_000]
    snapshot = _snapshot({"v1": start}, stamps=first, source=observed + timedelta(minutes=10))
    for step in range(1, 11):
        new_start = start + step * 7 * 60_000
        stamps = live_reminder.derive_first_seen(
            previous=snapshot,
            entries={"v1": {"scheduledStartMs": new_start}},
            observed_at=observed + timedelta(minutes=10 + step),
            now=observed,
            max_source_gap=timedelta(minutes=21),
        )
        minutes.append(new_start // 60_000)
        snapshot = _snapshot({"v1": new_start}, stamps=stamps, source=observed + timedelta(minutes=10 + step))

    stamp = snapshot.first_seen["v1"]
    assert stamp.start_minute == minutes[-1]
    assert list(stamp.prior_start_minutes) == minutes[-9:-1]  # the last eight BEFORE the current one
    assert len(stamp.prior_start_minutes) == live_reminder.MAX_PRIOR_START_MINUTES == 8
    assert minutes[0] not in stamp.prior_start_minutes and minutes[1] not in stamp.prior_start_minutes  # the two oldest were forgotten


def test_a_stored_prior_list_longer_than_eight_is_trimmed_to_the_newest_eight_when_read():
    """A stored prior list longer than eight is trimmed to the newest eight when read."""
    raw = {"v1": {"startMinute": 100, "firstSeenAt": None, "priorStartMinutes": list(range(20))}}

    assert live_reminder.parse_first_seen_map(raw)["v1"].prior_start_minutes == tuple(range(12, 20))


# ============ Issue 2: a reminder the user had not enabled at the original trigger time is never sent retroactively ============


@pytest.mark.parametrize(
    "saved_at, sends",
    [
        (F30 - timedelta(days=5), True),
        (F30 - timedelta(seconds=1), True),
        (F30, True),
        (F30 + timedelta(seconds=1), False),
        (SNAP_FOUND - timedelta(minutes=1), False),
        (SNAP_FOUND + timedelta(minutes=1), False),
        (None, False),
    ],
    ids=["days-before", "just-before", "exactly-at", "just-after", "after-fire-before-discovery", "after-discovery", "unknown"],
)
def test_the_reminder_setting_must_have_been_saved_by_the_fire_time(monkeypatch, saved_at, sends):
    """The reminder setting must have been saved by the fire time."""
    world = seeded_world(monkeypatch)
    world.saved_at[("c1", CREATOR_KEY)] = saved_at.isoformat() if saved_at else None

    world.run(RUN_AFTER)

    assert (len(world.catch_up_titles()) == 1) is sends


@pytest.mark.parametrize(
    "saved_at, sends",
    [(F30 - timedelta(days=1), True), (F30, True), (F30 + timedelta(seconds=1), False), (None, False)],
    ids=["before", "exactly-at", "just-after", "unknown"],
)
def test_the_push_subscription_must_have_existed_at_the_fire_time(monkeypatch, saved_at, sends):
    """Turning notifications OFF removes the subscription and turning them ON recreates it, so a switch turned ON after the due moment shows up here."""
    world = seeded_world(monkeypatch)
    world.saved_at[("c1", SUBSCRIPTION_KEY)] = saved_at.isoformat() if saved_at else None

    world.run(RUN_AFTER)

    assert (len(world.catch_up_titles()) == 1) is sends


def test_a_stream_override_saved_after_the_fire_time_does_not_inherit_the_older_creator_setting(monkeypatch):
    """A stream override saved after the fire time does not inherit the older creator setting."""
    world = seeded_world(monkeypatch)
    override_key = live_reminder.stream_override_key("v1")
    world.config[("c1", override_key)] = {**ADV30, "creatorId": "aizawa_ema"}
    world.saved_at[("c1", override_key)] = (F30 + timedelta(minutes=5)).isoformat()

    world.run(RUN_AFTER)

    assert world.pushes == []  # the winning item is the override, and it did not exist at 21:30


def test_the_winning_setting_is_the_one_that_is_checked(monkeypatch):
    """A newer creator setting that is SHADOWED by an older override does not matter: the override wins and it predates the fire time."""
    world = seeded_world(monkeypatch)
    override_key = live_reminder.stream_override_key("v1")
    world.config[("c1", override_key)] = {**ADV30, "creatorId": "aizawa_ema"}
    world.saved_at[("c1", override_key)] = (F30 - timedelta(days=1)).isoformat()
    world.saved_at[("c1", CREATOR_KEY)] = (F30 + timedelta(minutes=5)).isoformat()

    world.run(RUN_AFTER)

    assert len(world.catch_up_titles()) == 1


def test_the_setting_timestamp_never_invalidates_a_stored_setting():
    """The setting timestamp never invalidates a stored setting."""
    record = {"key": CREATOR_KEY, "value": ADV30}

    assert live_reminder.parse_reminder_settings([{**record, "updatedAt": "garbage"}], []).creator_all["aizawa_ema"].updated_at is None
    assert live_reminder.parse_reminder_settings([{**record, "updatedAt": "2026-10-10T00:00:00"}], []).creator_all["aizawa_ema"].updated_at is None  # no offset
    assert live_reminder.parse_reminder_settings([record], []).creator_all["aizawa_ema"].advance_reminder == "30min"
    assert live_reminder.LiveReminderSetting(True, "30min") == live_reminder.LiveReminderSetting(True, "30min", updated_at=datetime.now(UTC))  # not identity


# ---- mute and quiet hours are checked at the ORIGINAL fire time and at the send time ----


@pytest.mark.parametrize(
    "preference, sends",
    [
        (_preference_value(), True),
        (_preference_value(quietHours=["21:00", "21:45"]), False),  # quiet at 21:30 (the fire time), over by 21:51 (now)
        (_preference_value(quietHours=["21:45", "23:00"]), False),  # not quiet at 21:30, quiet at 21:51
        (_preference_value(quietHours=["03:00", "04:00"]), True),
        (_preference_value(temporaryMute="2026-10-18T12:40:00+00:00"), False),  # muted at the fire time, the mute ended before the run
        (_preference_value(temporaryMute="2026-10-18T12:20:00+00:00"), True),  # the mute ended before the fire time
    ],
    ids=["clear", "quiet-at-fire-time", "quiet-now", "quiet-elsewhere", "muted-at-fire-time", "mute-over-before-fire-time"],
)
def test_mute_and_quiet_hours_apply_at_the_original_fire_time_and_at_the_send_time(monkeypatch, preference, sends):
    """Mute and quiet hours apply at the original fire time and at the send time."""
    world = seeded_world(monkeypatch, preference=preference)

    world.run(RUN_AFTER)

    assert (len(world.catch_up_titles()) == 1) is sends
    if not sends:
        assert world.delivery == {}  # skipped, never recorded: nothing is delayed or replayed


def test_a_client_whose_global_switch_is_off_has_no_subscription_and_gets_nothing(monkeypatch):
    """A client whose global switch is off has no subscription and gets nothing."""
    world = seeded_world(monkeypatch)
    world.config.pop(("c1", SUBSCRIPTION_KEY))

    world.run(RUN_AFTER)

    assert world.pushes == []


# ============ Issue 3: the kill switch gates ONLY the catch-up ============


@pytest.mark.parametrize(
    "flag, sends",
    [
        ({"enabled": True}, True),
        ({"enabled": False}, False),
        (None, False),
        ({"enabled": "true"}, False),
        ({"enabled": 1}, False),
        ({"enabled": "yes"}, False),
        ({}, False),
        ({"on": True}, False),
    ],
    ids=["true", "false", "absent", "string-true", "one", "yes", "empty", "wrong-field"],
)
def test_only_a_stored_boolean_true_turns_the_catch_up_on(monkeypatch, flag, sends):
    """Only a stored boolean true turns the catch up on."""
    world = seeded_world(monkeypatch, flag=flag)

    world.run(RUN_AFTER)

    assert (len(world.catch_up_titles()) == 1) is sends


def test_an_unreadable_switch_means_off_and_the_run_carries_on(monkeypatch, capsys):
    """An unreadable switch means off and the run carries on."""
    world = seeded_world(monkeypatch)
    world.flag_error = RuntimeError("dynamodb unavailable")

    response = world.run(RUN_AFTER)

    assert response["statusCode"] == 200 and world.pushes == []
    assert "catch-up stays off" in capsys.readouterr().out


def test_the_switch_is_read_once_per_run_however_many_candidates_there_are(monkeypatch):
    """The switch is read once per run however many candidates there are."""
    world = seeded_world(monkeypatch)
    world.add_client("c2", creator_reminders={"aizawa_ema": ADV30})
    world.add_client("c3", creator_reminders={"aizawa_ema": ADV10})

    world.run(RUN_AFTER)

    assert world.flag_reads == 1
    assert len(world.catch_up_titles()) == 3


def test_a_run_with_no_catch_up_candidate_never_reads_the_switch(monkeypatch):
    """A run with no catch up candidate never reads the switch."""
    world = seeded_world(monkeypatch, first_seen_at=F30 - timedelta(hours=1))  # a known stream: nothing to catch up

    world.run(RUN_AFTER)
    world.run(F30 + timedelta(seconds=4))
    world.run(START + timedelta(seconds=4))

    assert world.flag_reads == 0
    assert len(world.pushes) == 2  # the on-time advance and the start reminder, unaffected


def test_the_switch_is_checked_before_the_earlier_reminder_batch_get(monkeypatch):
    """The switch is checked before the earlier reminder batch get."""
    world = seeded_world(monkeypatch)

    world.run(RUN_AFTER)

    assert world.events[:2] == ["flag", "handled"]  # switch first, then the delivery-log lookup


def test_a_switched_off_catch_up_makes_no_delivery_log_read_and_leaves_no_trace(monkeypatch):
    """A switched off catch up makes no delivery log read and leaves no trace."""
    world = seeded_world(monkeypatch, flag={"enabled": False})

    world.run(RUN_AFTER)

    assert world.events == ["flag"]
    assert world.handled_calls == [] and world.delivery == {} and world.pushes == []


def test_switching_it_on_later_still_sends_while_the_stream_is_before_the_cutoff(monkeypatch):
    """Switching it on later still sends while the stream is before the cutoff."""
    world = seeded_world(monkeypatch, flag={"enabled": False})
    world.run(RUN_AFTER)
    world.config[(SYSTEM, FLAG)] = ON

    world.run(RUN_AFTER + timedelta(minutes=1))

    assert [title.endswith("about 8 minutes") for title in world.titles()] == [True]


@pytest.mark.parametrize("flag", [None, {"enabled": False}, ON], ids=["absent", "off", "on"])
def test_the_on_time_advance_and_the_start_reminders_are_identical_in_every_switch_state(monkeypatch, flag):
    """The on time advance and the start reminders are identical in every switch state."""
    world = seeded_world(monkeypatch, flag=flag, first_seen_at=F30 - timedelta(hours=2))

    world.run(F30 + timedelta(seconds=4))
    world.run(START + timedelta(seconds=4))

    assert len(world.titles()) == 2
    assert world.titles()[0].endswith("goes live in 30 minutes")  # the on-time wording, not the catch-up's "about"
    assert world.titles()[1].endswith("is scheduled to go live now")
    assert world.flag_reads == 0  # the switch is never even asked about
    assert {video_id for (_client, video_id) in world.delivery} == {_minute_id("v1", "advance", START), _minute_id("v1", "start", START)}


# ============ failure recovery ============


def test_a_failed_push_releases_the_claim_and_the_next_minute_retries_once(monkeypatch):
    """A failed push releases the claim and the next minute retries once."""
    world = seeded_world(monkeypatch)
    world.push_results = [PushResult(sent=False, subscription_expired=False, error="boom")]

    world.run(RUN_AFTER)
    assert world.delivery == {}  # released
    world.run(RUN_AFTER + timedelta(minutes=1))
    world.run(RUN_AFTER + timedelta(minutes=2))

    assert [push["sent"] for push in world.pushes] == [False, True]


def test_retries_stop_at_the_two_minute_cutoff(monkeypatch):
    """Retries stop at the two minute cutoff."""
    world = seeded_world(monkeypatch)
    world.push_results = [PushResult(sent=False, subscription_expired=False, error="boom")] * 100

    attempts_by_run = []
    for minute in range(0, 9):  # the runs at 12:51:04 ... 12:59:04
        before = len(world.pushes)
        world.run(RUN_AFTER + timedelta(minutes=minute))
        attempts_by_run.append(len(world.pushes) - before)

    # 12:51:04 .. 12:57:04 retry (the last has 2 min 56 s left); 12:58:04 has 1 min 56 s left, so it and every later run stop
    assert attempts_by_run == [1, 1, 1, 1, 1, 1, 1, 0, 0]
    assert all(not push["sent"] for push in world.pushes)


def test_overlapping_runs_in_the_same_minute_send_once(monkeypatch):
    """Overlapping runs in the same minute send once."""
    world = seeded_world(monkeypatch)
    world.blind_precheck = True  # both runs pass the pre-check; only the atomic claim stands between them

    world.run(RUN_AFTER)
    world.run(RUN_AFTER)

    assert len(world.catch_up_titles()) == 1


def test_an_unreadable_earlier_reminder_guard_blocks_the_catch_up_but_not_the_run(monkeypatch, capsys):
    """An unreadable earlier reminder guard blocks the catch up but not the run."""
    world = seeded_world(monkeypatch)
    world.handled_error = RuntimeError("batch get failed")

    response = world.run(RUN_AFTER)

    assert response["statusCode"] == 200 and world.pushes == []
    assert "no catch-up" in capsys.readouterr().out
    world.handled_error = None
    world.run(RUN_AFTER + timedelta(minutes=1))
    assert len(world.catch_up_titles()) == 1  # the guard recovers on its own: nothing was recorded for the failed attempt


def test_a_failure_inside_the_catch_up_never_stops_the_start_reminder_that_follows_in_the_same_run(monkeypatch, capsys):
    """The catch-up is new and optional: an unexpected error in it is logged and skipped, and a later stream's start reminder still goes out."""
    world = seeded_world(monkeypatch)
    earlier_start = datetime(2026, 10, 18, 12, 51, 0, tzinfo=UTC)  # v2's start is due in this very run, after v1 in the schedule's order
    schedule = world.config[(SYSTEM, SCHEDULE)]
    schedule["entries"]["v2"] = {"creatorId": "aizawa_ema", "scheduledStartMs": _ms(earlier_start), "topic": None, "title": "Second stream", "status": "upcoming"}
    schedule["firstSeen"]["v2"] = {"startMinute": int(earlier_start.timestamp()) // 60, "firstSeenAt": "2026-10-18T11:00:07+00:00", "priorStartMinutes": []}
    real_send = world._send_push

    def flaky(subscription, *, title, body, data, vapid_private_key, vapid_claims):
        """Blow up only for the catch-up's own wording."""
        if "about" in title:
            raise RuntimeError("push library blew up")
        return real_send(subscription, title=title, body=body, data=data, vapid_private_key=vapid_private_key, vapid_claims=vapid_claims)

    monkeypatch.setattr(notification_dispatcher.push_sender, "send_push_notification", flaky)

    response = world.run(RUN_AFTER)

    assert response["statusCode"] == 200
    assert [push["title"].endswith("is scheduled to go live now") for push in world.pushes] == [True]
    assert world.pushes[0]["body"] == "Second stream"
    assert "late-discovery catch-up failed for video 'v1'" in capsys.readouterr().out


def test_a_dispatcher_outage_does_not_send_a_backlog_for_streams_known_before_it(monkeypatch):
    """A dispatcher outage does not send a backlog for streams known before it."""
    world = seeded_world(monkeypatch, first_seen_at=F30 - timedelta(minutes=20))

    world.run(START - timedelta(minutes=5))

    assert world.pushes == []


def test_no_extra_holodex_requests_and_the_derivation_count_is_exactly_the_snapshot_refreshes(monkeypatch):
    """The harness raises on any Holodex call; the schedule is derived once per NEWER shared snapshot and never otherwise."""
    world = make_world(monkeypatch)
    assert world.derivations == 1  # the empty one before the stream existed

    for minute in range(0, 8):
        world.run(RUN_AFTER + timedelta(minutes=minute))

    assert world.derivations == 2  # one more, for the 21:50 snapshot; the catch-up itself derived nothing
    assert len(world.catch_up_titles()) == 1


# ============ first-seen stamping, the deploy guard and its siblings ============


def _snapshot(entries: dict[str, int], *, stamps: dict | None, source: datetime | None) -> live_reminder.StreamScheduleSnapshot:
    """A parsed streamSchedule record carrying `entries` ({videoId: scheduledStartMs}) and `stamps` (None = the legacy shape without a map)."""
    value = {
        "entries": {video_id: {"creatorId": "aizawa_ema", "scheduledStartMs": ms} for video_id, ms in entries.items()},
        "refreshedAt": (source or datetime(2026, 10, 18, tzinfo=UTC)).isoformat(),
    }
    if source is not None:
        value["sourceRefreshedAt"] = source.isoformat()
    if stamps is not None:
        value[live_reminder.FIRST_SEEN_KEY] = live_reminder.first_seen_to_value(stamps)
    return live_reminder.parse_stream_schedule_snapshot(value)


GAP = timedelta(minutes=21)
T0 = datetime(2026, 10, 18, 12, 0, 7, tzinfo=UTC)
T1 = T0 + timedelta(minutes=10)
S1 = _ms(START)


def _derive(previous, entries, observed=T1, now=None):
    """live_reminder.derive_first_seen over raw {videoId: scheduledStartMs} entries with the test's usual gap limit."""
    return live_reminder.derive_first_seen(
        previous=previous, entries={video_id: {"scheduledStartMs": ms} for video_id, ms in entries.items()}, observed_at=observed, now=now or observed, max_source_gap=GAP
    )


def test_a_new_stream_in_a_tracked_derivation_is_stamped_with_the_snapshots_refresh_time_not_the_derivation_time():
    """A new stream in a tracked derivation is stamped with the snapshots refresh time not the derivation time."""
    stamps = _derive(_snapshot({}, stamps={}, source=T0), {"v1": S1}, observed=T1, now=T1 + timedelta(seconds=57))

    assert stamps["v1"] == live_reminder.FirstSeen(S1 // 60_000, T1, ())


@pytest.mark.parametrize(
    "previous",
    [
        None,
        _snapshot({"v1": S1}, stamps=None, source=T0),  # the deploy case: a record from before tracking existed
        _snapshot({"v1": S1}, stamps={}, source=None),  # the source's own refresh time was unknown
        _snapshot({"v1": S1}, stamps={}, source=T0 - timedelta(minutes=30)),  # an outage: more than 21 minutes since the last derivation
    ],
    ids=["no-record", "legacy-record", "unknown-source-time", "outage-gap"],
)
def test_the_deploy_guard_stamps_every_stream_without_a_trusted_history_as_known(previous):
    """The deploy guard stamps every stream without a trusted history as known."""
    stamps = _derive(previous, {"v1": S1, "v2": S1 + 60_000})

    assert stamps["v1"].first_seen_at is None and stamps["v2"].first_seen_at is None
    assert {stamp.start_minute for stamp in stamps.values()} == {S1 // 60_000, S1 // 60_000 + 1}


def test_an_unreadable_source_refresh_time_now_means_untrusted_stamps_even_with_a_tracked_previous_record():
    """An unreadable source refresh time now means untrusted stamps even with a tracked previous record."""
    stamps = live_reminder.derive_first_seen(
        previous=_snapshot({}, stamps={}, source=T0), entries={"v1": {"scheduledStartMs": S1}}, observed_at=None, now=T1, max_source_gap=GAP
    )

    assert stamps["v1"].first_seen_at is None


def test_a_snapshot_older_than_the_previous_one_is_not_trusted_either():
    """A refresh time that goes backwards (a clock oddity) is not a normal 10-minute step: nothing can be called first seen."""
    stamps = _derive(_snapshot({}, stamps={}, source=T1), {"v1": S1}, observed=T0)

    assert stamps["v1"].first_seen_at is None


def test_an_unchanged_start_keeps_its_stamp_across_derivations():
    """An unchanged start keeps its stamp across derivations."""
    first = _derive(_snapshot({}, stamps={}, source=T0), {"v1": S1}, observed=T1)
    later = _derive(_snapshot({"v1": S1}, stamps=first, source=T1), {"v1": S1}, observed=T1 + timedelta(minutes=10))

    assert later["v1"] == first["v1"] and later["v1"].first_seen_at == T1


def test_a_legacy_stream_stays_known_after_the_first_tracked_derivation_and_a_later_new_stream_is_stamped():
    """A legacy stream stays known after the first tracked derivation and a later new stream is stamped."""
    deploy = _derive(_snapshot({"v1": S1}, stamps=None, source=T0), {"v1": S1})
    after = _derive(_snapshot({"v1": S1}, stamps=deploy, source=T1), {"v1": S1, "v2": S1}, observed=T1 + timedelta(minutes=10))

    assert after["v1"].first_seen_at is None
    assert after["v2"].first_seen_at == T1 + timedelta(minutes=10)


def test_a_known_stream_whose_stamp_was_lost_stays_known_never_new():
    """A known stream whose stamp was lost stays known never new."""
    previous = _snapshot({"v1": S1}, stamps={}, source=T0)  # tracked, but v1 has no stamp (e.g. an unusable item was dropped)

    stamps = _derive(previous, {"v1": S1}, observed=T1)

    assert stamps["v1"].first_seen_at is None


def test_a_reschedule_is_a_new_observation_that_remembers_the_old_start():
    """A reschedule is a new observation that remembers the old start."""
    first = _derive(_snapshot({}, stamps={}, source=T0), {"v1": S1}, observed=T1)
    moved = _derive(_snapshot({"v1": S1}, stamps=first, source=T1), {"v1": S1 - 20 * 60_000}, observed=T1 + timedelta(minutes=10))

    assert moved["v1"] == live_reminder.FirstSeen((S1 - 20 * 60_000) // 60_000, T1 + timedelta(minutes=10), (S1 // 60_000,))


def test_a_legacy_stream_that_is_rescheduled_gets_a_real_stamp_and_remembers_its_old_start():
    """A legacy stream that is rescheduled gets a real stamp and remembers its old start."""
    deploy = _derive(_snapshot({"v1": S1}, stamps=None, source=T0), {"v1": S1})
    moved = _derive(_snapshot({"v1": S1}, stamps=deploy, source=T1), {"v1": S1 - 20 * 60_000}, observed=T1 + timedelta(minutes=10))

    assert moved["v1"].first_seen_at == T1 + timedelta(minutes=10) and moved["v1"].prior_start_minutes == (S1 // 60_000,)


def test_a_one_snapshot_dropout_does_not_make_the_returning_stream_look_new():
    """A one snapshot dropout does not make the returning stream look new."""
    first = _derive(_snapshot({}, stamps={}, source=T0), {"v1": S1}, observed=T1)
    dropped = _derive(_snapshot({"v1": S1}, stamps=first, source=T1), {}, observed=T1 + timedelta(minutes=10))
    back = _derive(_snapshot({}, stamps=dropped, source=T1 + timedelta(minutes=10)), {"v1": S1}, observed=T1 + timedelta(minutes=20))

    assert "v1" in dropped and back["v1"] == first["v1"]


def test_a_stamp_is_dropped_two_hours_after_the_stream_started():
    """A stamp is dropped two hours after the stream started."""
    first = _derive(_snapshot({}, stamps={}, source=T0), {"v1": S1}, observed=T1)
    start = datetime.fromtimestamp(S1 / 1000, tz=UTC)

    still = _derive(_snapshot({}, stamps=first, source=start + timedelta(hours=1)), {}, observed=start + timedelta(hours=1, minutes=10), now=start + timedelta(hours=1, minutes=10))
    gone = _derive(_snapshot({}, stamps=first, source=start + timedelta(hours=2)), {}, observed=start + timedelta(hours=2, minutes=10), now=start + timedelta(hours=2, minutes=10))

    assert "v1" in still and "v1" not in gone


def test_a_corrupt_or_empty_first_seen_never_invalidates_the_schedule():
    """A corrupt or empty first seen never invalidates the schedule."""
    base = {"entries": {"v1": {"creatorId": "aizawa_ema", "scheduledStartMs": S1}}, "refreshedAt": T0.isoformat()}

    for raw in ("garbage", ["a"], 7, None):
        snapshot = live_reminder.parse_stream_schedule_snapshot({**base, "firstSeen": raw})
        assert snapshot.first_seen is None and snapshot.entries["v1"].first_seen is None
    snapshot = live_reminder.parse_stream_schedule_snapshot(
        {**base, "firstSeen": {"v1": {"startMinute": "x"}, "": {"startMinute": 1}, "v2": 5, "v3": {"startMinute": True}}}
    )
    assert snapshot.first_seen == {} and snapshot.entries["v1"].first_seen is None


def test_an_old_record_and_unknown_future_fields_still_parse():
    """An old record and unknown future fields still parse."""
    snapshot = live_reminder.parse_stream_schedule_snapshot(
        {
            "entries": {"v1": {"creatorId": "aizawa_ema", "scheduledStartMs": S1, "futureField": 1, "status": 7}},
            "refreshedAt": T0.isoformat(),
            "firstSeen": {"v1": {"startMinute": S1 // 60_000, "firstSeenAt": "bad", "priorStartMinutes": ["x", 3, True, 4], "alsoNew": 1}},
        }
    )

    assert snapshot.entries["v1"].status is None  # a non-string status is only "unknown"
    assert snapshot.entries["v1"].first_seen == live_reminder.FirstSeen(S1 // 60_000, None, (3, 4))


def test_a_stamp_for_another_start_minute_is_not_attached_to_the_entry():
    """A stamp for another start minute is not attached to the entry."""
    snapshot = live_reminder.parse_stream_schedule_snapshot(
        {
            "entries": {"v1": {"creatorId": "aizawa_ema", "scheduledStartMs": S1}},
            "refreshedAt": T0.isoformat(),
            "firstSeen": {"v1": {"startMinute": S1 // 60_000 - 5, "firstSeenAt": T0.isoformat(), "priorStartMinutes": []}},
        }
    )

    assert snapshot.entries["v1"].first_seen is None


def test_first_seen_round_trips_through_its_stored_form():
    """First seen round trips through its stored form."""
    stamps = {"v1": live_reminder.FirstSeen(5, T0, (1, 2)), "v2": live_reminder.FirstSeen(9, None, ())}

    assert live_reminder.parse_first_seen_map(live_reminder.first_seen_to_value(stamps)) == stamps


# ---- end to end: the guard through the real derivation ----


def _stored_first_seen(world: CatchUpHarness) -> dict:
    """The firstSeen map the dispatcher last stored in the streamSchedule record."""
    return world.config[(SYSTEM, SCHEDULE)]["firstSeen"]


def test_deploying_over_a_record_without_first_seen_sends_no_catch_up_burst_and_stamps_everything_as_known(monkeypatch):
    """Deploying over a record without first seen sends no catch up burst and stamps everything as known."""
    world = CatchUpHarness(monkeypatch)
    world.add_client("c1", creator_reminders={"aizawa_ema": ADV30})
    world.config[(SYSTEM, FLAG)] = ON
    world.config[(SYSTEM, SCHEDULE)] = {  # the record the previous deploy wrote: no firstSeen at all
        "entries": {"v1": {"creatorId": "aizawa_ema", "scheduledStartMs": _ms(START), "topic": None, "title": "Ranked grind", "status": "upcoming"}},
        "refreshedAt": SNAP_EMPTY.isoformat(),
        "sourceRefreshedAt": SNAP_EMPTY.isoformat(),
    }
    world.refresh_snapshot([_stream(start=START), _stream("v2", start=START)], SNAP_FOUND)

    world.run(RUN_AFTER)

    assert world.pushes == []  # both streams' 30-minute times had passed; neither is "new"
    assert {stamp["firstSeenAt"] for stamp in _stored_first_seen(world).values()} == {None}
    assert set(_stored_first_seen(world)) == {"v1", "v2"}


def test_after_the_guarded_derivation_a_genuinely_new_stream_is_caught_up_and_the_known_ones_are_not(monkeypatch):
    """After the guarded derivation a genuinely new stream is caught up and the known ones are not."""
    world = CatchUpHarness(monkeypatch)
    world.add_client("c1", creator_reminders={"aizawa_ema": ADV30})
    world.config[(SYSTEM, FLAG)] = ON
    world.refresh_snapshot([_stream(start=START)], SNAP_EMPTY)
    world.run(SNAP_EMPTY + timedelta(seconds=58))  # no previous record: guarded, v1 is stamped as known
    later_start = START + timedelta(minutes=15)  # its 30-minute time (12:45) passed before the 21:50 snapshot first carried it
    world.refresh_snapshot([_stream(start=START), _stream("v3", start=later_start)], SNAP_FOUND)

    world.run(RUN_AFTER)

    assert [title.endswith("goes live in about 24 minutes") for title in world.titles()] == [True]
    assert world.pushes[0]["data"]["videoId"] == "v3"
    assert _stored_first_seen(world)["v1"]["firstSeenAt"] is None and _stored_first_seen(world)["v3"]["firstSeenAt"] is not None


def test_an_invalid_stored_schedule_is_treated_as_absent_and_guarded(monkeypatch):
    """An invalid stored schedule is treated as absent and guarded."""
    world = CatchUpHarness(monkeypatch)
    world.add_client("c1", creator_reminders={"aizawa_ema": ADV30})
    world.config[(SYSTEM, FLAG)] = ON
    world.config[(SYSTEM, SCHEDULE)] = {"entries": "garbage"}
    world.refresh_snapshot([_stream(start=START)], SNAP_FOUND)

    world.run(RUN_AFTER)

    assert world.pushes == [] and _stored_first_seen(world)["v1"]["firstSeenAt"] is None


def test_after_a_long_outage_streams_that_were_listed_for_hours_are_not_treated_as_new(monkeypatch):
    """After a long outage streams that were listed for hours are not treated as new."""
    world = CatchUpHarness(monkeypatch)
    world.add_client("c1", creator_reminders={"aizawa_ema": ADV30})
    world.config[(SYSTEM, FLAG)] = ON
    world.refresh_snapshot([], datetime(2026, 10, 18, 12, 0, 7, tzinfo=UTC))
    world.run(datetime(2026, 10, 18, 12, 0, 58, tzinfo=UTC))
    world.refresh_snapshot([_stream(start=START)], datetime(2026, 10, 18, 12, 35, 7, tzinfo=UTC))  # 35 minutes later: the display job was down

    world.run(datetime(2026, 10, 18, 12, 36, 4, tzinfo=UTC))

    assert world.pushes == [] and _stored_first_seen(world)["v1"]["firstSeenAt"] is None


def test_without_a_readable_snapshot_freshness_new_streams_are_never_caught_up(monkeypatch):
    """Without a readable snapshot freshness new streams are never caught up."""
    world = make_world(monkeypatch)
    world.snapshot_at = None  # the heartbeat cannot be read: the time-based fallback re-derives, but nothing can be trusted as "first seen"

    world.run(RUN_AFTER + timedelta(minutes=11))

    assert world.pushes == []


def test_the_stored_schedule_carries_the_status_and_the_stamp(monkeypatch):
    """The stored schedule carries the status and the stamp."""
    world = make_world(monkeypatch)
    world.run(RUN_AFTER)

    stored = world.config[(SYSTEM, SCHEDULE)]

    assert stored["entries"]["v1"]["status"] == "upcoming"
    assert stored["firstSeen"]["v1"] == {"startMinute": START_MINUTE, "firstSeenAt": SNAP_FOUND.isoformat(), "priorStartMinutes": []}
    assert stored["sourceRefreshedAt"] == SNAP_FOUND.isoformat()


# ============ wording ============


@pytest.mark.parametrize(
    "locale, expected",
    [
        ("zh-TW", "藍沢エマ 將於約 9 分鐘後開播"),
        ("ja", "藍沢エマ は約9分後に配信開始"),
        ("en", "藍沢エマ goes live in about 9 minutes"),
        ("fr", "藍沢エマ goes live in about 9 minutes"),  # an unsupported locale means en, like every other notification
        (None, "藍沢エマ goes live in about 9 minutes"),
    ],
)
def test_the_catch_up_title_in_every_locale_names_the_actual_minutes(locale, expected):
    """The catch up title in every locale names the actual minutes."""
    text = notification_text.reminder_notification(locale=locale, kind="advance", advance="30min", creator_name="藍沢エマ", stream_title="Ranked grind", remaining_minutes=9)

    assert text.title == expected and text.body == "Ranked grind"


def test_the_catch_up_body_falls_back_like_every_other_reminder_and_the_name_too():
    """The catch up body falls back like every other reminder and the name too."""
    text = notification_text.reminder_notification(locale="en", kind="advance", advance="10min", creator_name=None, stream_title="  ", remaining_minutes=5)

    assert text.title == "A creator you follow goes live in about 5 minutes" and text.body == "Live stream"


@pytest.mark.parametrize("remaining", [1, 0, -3, True, "5", 4.5])
def test_a_catch_up_needs_a_whole_number_of_at_least_two_minutes(remaining):
    """A catch up needs a whole number of at least two minutes."""
    with pytest.raises(ValueError):
        notification_text.reminder_notification(locale="en", kind="advance", advance="30min", creator_name="X", stream_title="t", remaining_minutes=remaining)


def test_a_start_reminder_cannot_carry_remaining_minutes_and_the_on_time_titles_are_unchanged():
    """A start reminder cannot carry remaining minutes and the on time titles are unchanged."""
    with pytest.raises(ValueError):
        notification_text.reminder_notification(locale="en", kind="start", advance=None, creator_name="X", stream_title="t", remaining_minutes=5)
    assert notification_text.reminder_notification(locale="en", kind="advance", advance="30min", creator_name="X", stream_title="t").title == "X goes live in 30 minutes"
    assert notification_text.reminder_notification(locale="zh-TW", kind="start", advance=None, creator_name="X", stream_title="t").title == "X 預定現在開播"


# ============ the pure rule, line by line ============


def _due(**overrides) -> bool:
    """live_reminder.is_advance_catch_up_due for the incident's inputs, with any of them overridden."""
    arguments = {
        "setting": live_reminder.LiveReminderSetting(True, "30min", updated_at=F30 - timedelta(days=1)),
        "scheduled_start_ms": S1,
        "now_ms": _ms(RUN_AFTER),
        "window_ms": 60_000,
        "status": "upcoming",
        "first_seen": live_reminder.FirstSeen(S1 // 60_000, SNAP_FOUND, ()),
        "subscription_updated_at": F30 - timedelta(days=1),
    }
    arguments.update(overrides)
    return live_reminder.is_advance_catch_up_due(
        arguments.pop("setting"), arguments.pop("scheduled_start_ms"), **arguments
    )


def test_the_pure_rule_accepts_the_incident():
    """The pure rule accepts the incident."""
    assert _due() is True


@pytest.mark.parametrize(
    "overrides",
    [
        {"status": "live"},
        {"first_seen": None},
        {"first_seen": live_reminder.FirstSeen(S1 // 60_000, None, ())},
        {"first_seen": live_reminder.FirstSeen(S1 // 60_000 + 1, SNAP_FOUND, ())},
        {"now_ms": _ms(F30) + 59_999},  # the on-time window still owns this moment
        {"now_ms": _ms(START) - 119_999},
        {"subscription_updated_at": None},
        {"setting": live_reminder.LiveReminderSetting(True, None)},
        {"setting": live_reminder.LiveReminderSetting(True, "30min")},  # saved-at unknown
    ],
)
def test_the_pure_rule_refuses_each_condition_on_its_own(overrides):
    """The pure rule refuses each condition on its own."""
    assert _due(**overrides) is False


def test_the_catch_up_starts_exactly_when_the_on_time_window_closes_so_the_two_never_overlap():
    """The catch up starts exactly when the on time window closes so the two never overlap."""
    setting = live_reminder.LiveReminderSetting(True, "30min", updated_at=F30 - timedelta(days=1))
    just_after = _ms(F30) + 60_000
    assert live_reminder.is_advance_reminder_due(setting, S1, now_ms=just_after - 1, window_ms=60_000) is True
    assert _due(now_ms=just_after - 1) is False
    assert live_reminder.is_advance_reminder_due(setting, S1, now_ms=just_after, window_ms=60_000) is False
    assert _due(now_ms=just_after) is True
