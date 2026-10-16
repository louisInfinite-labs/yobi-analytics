"""開播時通知 = the notification goes out when the STORED scheduled start time arrives -- not after YouTube/Holodex confirms the stream is live.

End to end through notification_dispatcher.lambda_handler with a stateful in-memory fake of everything outside the dispatcher: the config store
(preferences, subscriptions, reminder settings, the derived "streamSchedule"), the delivery log (atomic claim / confirm / release, like the real
conditional writes), the push sender, and the SHARED live/upcoming snapshot the schedule is derived from (which only a 10-minute job refreshes from
Holodex). Nothing here can reach Holodex: the dispatcher must never need to.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from api import read_api

read_api_real_get_live_streams = read_api.get_live_streams  # captured before any test patches it
from notifications import live_reminder, notification_dispatcher, notification_text, push_sender
from notifications.push_sender import PushResult
from stores import notification_delivery_log_store, remote_config_store
from tests.notifications.test_notification_dispatcher import _creator, _preference_value, _subscription_value

UTC = timezone.utc
# 21:15 JST on 2026-10-17: the example from the product decision.
START = datetime(2026, 10, 17, 12, 15, 0, tzinfo=UTC)
SNAPSHOT_AT = datetime(2026, 10, 17, 12, 0, 0, tzinfo=UTC)  # the :00 tick of the 10-minute snapshot
REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def _frozen(now: datetime) -> type[datetime]:
    """A datetime whose now() is `now` (keeps fromisoformat & friends)."""

    class _Frozen(datetime):
        """A datetime whose now() is the pinned instant (every other classmethod keeps working)."""

        @classmethod
        def now(cls, tz=None):
            """The pinned instant."""
            return now.astimezone(tz) if tz else now

    return _Frozen


def _stream(video_id="v1", *, start: datetime | None = START, status="upcoming", actual: datetime | None = None, creator="aizawa_ema", title="Ranked grind") -> dict:
    """One stream as GET /live-streams lists it."""
    return {
        "videoId": video_id,
        "creatorId": creator,
        "channelName": creator,
        "title": title,
        "status": status,
        "scheduledStart": start.isoformat() if start else None,
        "actualStart": actual.isoformat() if actual else None,
        "thumbnailUrl": None,
    }


class Harness:
    """The dispatcher's whole outside world, in memory."""

    def __init__(self, monkeypatch):
        """Wire every boundary the dispatcher touches."""
        self.config: dict[tuple[str, str], dict] = {}
        self.delivery: dict[tuple[str, str], dict] = {}
        self.pushes: list[dict] = []
        self.push_results: list[PushResult] = []  # consumed first; empty -> sent
        self.snapshot: list[dict] = []
        self.snapshot_at: datetime | None = SNAPSHOT_AT
        self.derivations = 0
        self.blind_precheck = False  # simulate two overlapping runs that both pass the already_delivered pre-check
        self.creators = [_creator()]

        monkeypatch.setattr(notification_dispatcher, "get_vapid_credentials", lambda: ("pem", {"sub": "mailto:a@b.com"}))
        monkeypatch.setattr(notification_dispatcher, "load_creators", lambda: self.creators)
        monkeypatch.setattr(notification_dispatcher, "_read_source_refreshed_at", lambda: self.snapshot_at)
        monkeypatch.setattr(read_api, "get_live_streams", self._get_live_streams)
        monkeypatch.setattr(read_api, "holodex_get", self._no_holodex)
        monkeypatch.setattr(remote_config_store, "get_remote_config", self._get_config)
        monkeypatch.setattr(remote_config_store, "put_remote_config", self._put_config)
        monkeypatch.setattr(remote_config_store, "list_by_key", self._list_by_key)
        monkeypatch.setattr(remote_config_store, "list_remote_config_by_prefix", self._list_by_prefix)
        monkeypatch.setattr(notification_delivery_log_store, "already_delivered", self._already_delivered)
        monkeypatch.setattr(notification_delivery_log_store, "handled_within", self._handled_within)
        monkeypatch.setattr(notification_delivery_log_store, "mark_delivered", self._mark_delivered)
        monkeypatch.setattr(notification_delivery_log_store, "confirm_delivered", self._confirm_delivered)
        monkeypatch.setattr(notification_delivery_log_store, "release_claim", self._release_claim)
        monkeypatch.setattr(push_sender, "send_push_notification", self._send_push)
        self._monkeypatch = monkeypatch

    # ---- fakes ----
    def _no_holodex(self, path, params=None):
        """Any Holodex request from the dispatcher path is a bug."""
        raise AssertionError("the notification dispatcher must never reach Holodex")

    def _get_live_streams(self, *_args, **_kwargs):
        """read_api.get_live_streams over the shared snapshot -- counts how often the dispatcher derives its schedule."""
        self.derivations += 1
        return {"streams": list(self.snapshot)}

    def _get_config(self, client_id, key):
        """remote_config_store.get_remote_config."""
        value = self.config.get((client_id, key))
        return {"clientId": client_id, "key": key, "value": value, "updatedAt": "2026-10-17T00:00:00+00:00"} if value is not None else None

    def _put_config(self, record):
        """remote_config_store.put_remote_config (a full overwrite, like the real one)."""
        self.config[(record["clientId"], record["key"])] = record["value"]

    def _list_by_key(self, key):
        """remote_config_store.list_by_key: every client holding `key`."""
        return [{"clientId": client, "value": value} for (client, k), value in self.config.items() if k == key]

    def _list_by_prefix(self, client_id, prefix):
        """remote_config_store.list_remote_config_by_prefix for one client."""
        return [
            {"clientId": client, "key": k, "value": value, "updatedAt": "2026-01-01T00:00:00+00:00"}
            for (client, k), value in self.config.items()
            if client == client_id and k.startswith(prefix)
        ]

    def _already_delivered(self, client_id, video_id, *, now=None):
        """The delivery log's pre-check (blindable, to model two runs that race past it)."""
        if self.blind_precheck:
            return False
        return (client_id, video_id) in self.delivery

    def _handled_within(self, client_id, video_id, within, *, now=None):
        """The delivery log's bounded legacy check: a row counts only while its timestamp is within `within` of `now`."""
        row = self.delivery.get((client_id, video_id))
        return row is not None and now - datetime.fromisoformat(row["at"]) <= within

    def _mark_delivered(self, client_id, video_id, claimed_at, *, now=None):
        """The atomic claim: a conditional put that only the first caller wins."""
        if (client_id, video_id) in self.delivery:  # the real store's conditional put
            return False
        self.delivery[(client_id, video_id)] = {"status": "claimed", "at": claimed_at}
        return True

    def _confirm_delivered(self, client_id, video_id, delivered_at):
        """Turn an owned claim into a permanent delivery."""
        self.delivery[(client_id, video_id)] = {"status": "delivered", "at": delivered_at}

    def _release_claim(self, client_id, video_id):
        """Give a claim back after a failed send so a retry can deliver."""
        self.delivery.pop((client_id, video_id), None)

    def _send_push(self, subscription, *, title, body, data, vapid_private_key, vapid_claims):
        """push_sender.send_push_notification: record the push and answer from the scripted results (default: sent)."""
        result = self.push_results.pop(0) if self.push_results else PushResult(sent=True, subscription_expired=False)
        self.pushes.append({"title": title, "body": body, "data": data, "sent": result.sent, "endpoint": subscription["endpoint"]})
        return result

    # ---- scenario helpers ----
    def add_client(self, client_id="c1", *, preference=None, creator_reminders=None, overrides=None, subscribed=True):
        """A subscriber: stored preference, push subscription, and the reminder settings of one kind or another."""
        self.config[(client_id, notification_dispatcher._NOTIFICATION_PREFERENCE_KEY)] = preference if preference is not None else _preference_value()
        if subscribed:
            self.config[(client_id, notification_dispatcher._PUSH_SUBSCRIPTION_KEY)] = {**_subscription_value(), "endpoint": f"https://push.example/{client_id}"}
        for creator_id, setting in (creator_reminders or {}).items():
            self.config[(client_id, live_reminder.creator_reminder_key(creator_id, "all"))] = setting
        for video_id, setting in (overrides or {}).items():
            self.config[(client_id, live_reminder.stream_override_key(video_id))] = setting

    def refresh_snapshot(self, streams: list[dict], at: datetime) -> None:
        """The 10-minute display job ran at `at` and now lists `streams`."""
        self.snapshot = streams
        self.snapshot_at = at

    def run(self, now: datetime) -> dict:
        """One dispatcher invocation at `now`."""
        self._monkeypatch.setattr(notification_dispatcher, "datetime", _frozen(now))
        return notification_dispatcher.lambda_handler({}, None)

    def titles(self) -> list[str]:
        """The titles of every push that actually went out."""
        return [push["title"] for push in self.pushes if push["sent"]]


AT_START = {"notifyAtStart": True, "advanceReminder": None}


@pytest.fixture
def harness(monkeypatch):
    """A Harness with one subscriber (c1) who wants every start of aizawa_ema, and the 21:15 JST stream already in the shared snapshot at :00."""
    world = Harness(monkeypatch)
    world.add_client("c1", creator_reminders={"aizawa_ema": AT_START})
    world.refresh_snapshot([_stream()], SNAPSHOT_AT)
    return world


# ============ the scheduled minute ============


def test_the_start_notification_goes_out_in_the_minute_the_stored_scheduled_start_arrives_and_not_before_or_after(harness):
    """21:00 the backend already knows videoId + scheduledStart 21:15 JST; at 21:15 the dispatcher sends. Nothing before; nothing after; one push."""
    assert harness.run(START - timedelta(minutes=1, seconds=30))["delivered"] == 0
    assert harness.run(START - timedelta(seconds=5))["delivered"] == 0
    assert harness.pushes == []

    summary = harness.run(START + timedelta(seconds=10))

    assert summary["delivered"] == 1
    assert [push["data"] for push in harness.pushes] == [{"videoId": "v1", "reminderKind": "start"}]
    assert harness.run(START + timedelta(seconds=70))["delivered"] == 0  # the next minute's run: outside the window, and already delivered
    assert len(harness.pushes) == 1


def test_the_start_notification_never_waits_for_or_needs_a_live_confirmation(harness):
    """The stream is still `upcoming` in the snapshot throughout -- as it would be if the creator is late or never starts: it still goes out."""
    assert harness.snapshot[0]["status"] == "upcoming" and harness.snapshot[0]["actualStart"] is None

    harness.run(START + timedelta(seconds=10))

    assert len(harness.pushes) == 1
    assert harness.snapshot[0]["status"] == "upcoming"  # nothing in the flow changed it or asked anyone about it


def test_the_wording_is_a_scheduled_start_reminder_and_never_claims_the_stream_is_live(harness):
    """en / ja / zh-TW alike: 'scheduled' -- YouTube has not confirmed anything at this minute."""
    for locale, expected in (("en", "is scheduled to go live now"), ("ja", "の配信開始予定時刻です"), ("zh-TW", "預定現在開播")):
        harness.add_client(f"c-{locale}", preference=_preference_value(notificationLocale=locale), creator_reminders={"aizawa_ema": AT_START})
    harness.run(START + timedelta(seconds=10))

    titles = {push["endpoint"].rsplit("/", 1)[1]: push["title"] for push in harness.pushes}
    assert titles["c-en"].endswith("is scheduled to go live now")
    assert titles["c-ja"].endswith("の配信開始予定時刻です")
    assert titles["c-zh-TW"].endswith("預定現在開播")
    for title in titles.values():
        assert not any(claim in title for claim in ("is live now", "已開始", "を開始しました", "is now live"))


@pytest.mark.parametrize("advance", ["1min", "10min", "30min", "1hour"])
def test_the_existing_pre_start_reminders_fire_at_their_offsets_from_the_same_stored_start(harness, advance):
    """1, 10, 30 and 60 minutes before the stored start -- each in its own minute, with the at-start option independent of them."""
    offset = live_reminder.ADVANCE_REMINDER_OFFSET_MINUTES[advance]
    harness.add_client("c2", creator_reminders={"aizawa_ema": {"notifyAtStart": False, "advanceReminder": advance}})
    harness.config.pop(("c1", live_reminder.creator_reminder_key("aizawa_ema", "all")))  # only c2 for this case

    assert harness.run(START - timedelta(minutes=offset, seconds=-1) - timedelta(minutes=1))["delivered"] == 0  # a minute too early
    summary = harness.run(START - timedelta(minutes=offset) + timedelta(seconds=10))

    assert summary["delivered"] == 1
    assert harness.pushes[0]["data"] == {"videoId": "v1", "reminderKind": "advance"}
    assert harness.run(START + timedelta(seconds=10))["delivered"] == 0  # at-start was NOT requested by c2


def test_an_advance_reminder_and_the_at_start_notification_can_both_apply_to_the_same_stream(harness):
    """notifyAtStart and advanceReminder are independent dimensions of one setting."""
    harness.config[("c1", live_reminder.creator_reminder_key("aizawa_ema", "all"))] = {"notifyAtStart": True, "advanceReminder": "10min"}

    harness.run(START - timedelta(minutes=10) + timedelta(seconds=10))
    harness.run(START + timedelta(seconds=10))

    assert [push["data"]["reminderKind"] for push in harness.pushes] == ["advance", "start"]


# ============ who is eligible ============


def test_only_eligible_subscribers_receive_the_notification(harness, monkeypatch):
    """Setting present + subscribed + not muted + the right creator. No setting, no subscription, a muted client and another creator's fan: nothing."""
    harness.creators = [_creator(), _creator(creator_id="usada_pekora", display_name="兎田ぺこら", youtube_channel_id="UC_other")]
    harness.add_client("no_setting")
    harness.add_client("no_subscription", creator_reminders={"aizawa_ema": AT_START}, subscribed=False)
    harness.add_client("other_creator_fan", creator_reminders={"usada_pekora": AT_START})
    muted = _preference_value(temporaryMute={"until": (START + timedelta(hours=2)).isoformat()})
    harness.add_client("muted", preference=muted, creator_reminders={"aizawa_ema": AT_START})

    harness.run(START + timedelta(seconds=10))

    assert sorted(push["endpoint"].rsplit("/", 1)[1] for push in harness.pushes) == ["c1"]


def test_a_per_stream_override_beats_the_creator_setting_for_that_stream_only(harness):
    """Preference precedence is untouched: an override that turns the start notification off silences just that stream."""
    harness.refresh_snapshot([_stream("v1"), _stream("v2")], SNAPSHOT_AT)
    harness.config[("c1", live_reminder.stream_override_key("v1"))] = {"creatorId": "aizawa_ema", "notifyAtStart": False, "advanceReminder": None}

    harness.run(START + timedelta(seconds=10))

    assert [push["data"]["videoId"] for push in harness.pushes] == ["v2"]


# ============ one shared timer, one derivation, never Holodex ============


def test_one_dispatcher_run_serves_fifty_subscribers_with_one_derivation_and_no_holodex_request(harness):
    """No per-user timer and no per-user upstream request: the same run reads the schedule once and pushes to everyone."""
    for index in range(2, 51):
        harness.add_client(f"c{index}", creator_reminders={"aizawa_ema": AT_START})
    harness.run(START - timedelta(minutes=5))  # derives the schedule from the snapshot once
    assert harness.derivations == 1

    summary = harness.run(START + timedelta(seconds=10))

    assert summary["delivered"] == 50 and len(harness.pushes) == 50
    assert harness.derivations == 1  # the start minute itself needed no new derivation, let alone a Holodex request


def test_there_is_one_shared_reminder_timer_not_one_scheduler_per_user_or_per_stream():
    """Static: the only notification schedules are the single reminder dispatcher and the single 15-minute new-video slot dispatcher, and neither
    is expanded per user or per stream."""
    terraform = (REPO_ROOT / "terraform" / "eventbridge.tf").read_text(encoding="utf-8")
    schedules = [part.split('"')[1] for part in terraform.split('resource "aws_scheduler_schedule" ')[1:]]
    notification = [name for name in schedules if "notif" in name or "reminder" in name or "dispatch" in name]

    assert sorted(notification) == ["new_video_dispatch", "notification_dispatch"]
    for name in notification:
        block = terraform[terraform.index(f'resource "aws_scheduler_schedule" "{name}"') :].split("\nresource ")[0]
        assert "for_each" not in block and "count " not in block


# ============ following the shared snapshot ============


def test_the_schedule_is_re_derived_when_and_only_when_the_shared_snapshot_changes(harness):
    """Many runs between two 10-minute snapshots cost zero derivations; the first run after a new snapshot costs exactly one."""
    harness.run(START - timedelta(minutes=14))
    for minute in range(13, 5, -1):
        harness.run(START - timedelta(minutes=minute))
    assert harness.derivations == 1

    harness.refresh_snapshot([_stream()], SNAPSHOT_AT + timedelta(minutes=10))
    harness.run(START - timedelta(minutes=4))
    harness.run(START - timedelta(minutes=3))

    assert harness.derivations == 2


def test_the_stored_schedule_records_which_snapshot_it_was_derived_from(harness):
    """The record carries sourceRefreshedAt so the next run can tell whether it is still current."""
    harness.run(START - timedelta(minutes=5))

    stored = harness.config[(live_reminder.SYSTEM_CLIENT_ID, live_reminder.STREAM_SCHEDULE_KEY)]
    assert stored["sourceRefreshedAt"] == SNAPSHOT_AT.isoformat()
    assert live_reminder.parse_stream_schedule_snapshot(stored).source_refreshed_at == SNAPSHOT_AT


def test_when_the_snapshots_freshness_is_unknown_the_time_based_fallback_decides(harness):
    """No heartbeat / store hiccup: re-derive once the stored entries are _SCHEDULE_REFRESH_INTERVAL old, exactly as before the source was tracked."""
    harness.snapshot_at = None
    harness.run(START - timedelta(minutes=30))
    harness.run(START - timedelta(minutes=30) + notification_dispatcher._SCHEDULE_REFRESH_INTERVAL - timedelta(seconds=1))
    assert harness.derivations == 1

    harness.run(START - timedelta(minutes=30) + notification_dispatcher._SCHEDULE_REFRESH_INTERVAL)

    assert harness.derivations == 2


def test_a_schedule_record_from_before_the_source_was_tracked_is_re_derived_once(harness):
    """A legacy record has no sourceRefreshedAt: it is replaced by the next run, then followed normally."""
    harness.config[(live_reminder.SYSTEM_CLIENT_ID, live_reminder.STREAM_SCHEDULE_KEY)] = {"entries": {}, "refreshedAt": (START - timedelta(minutes=5)).isoformat()}

    harness.run(START - timedelta(minutes=4))
    harness.run(START - timedelta(minutes=3))

    assert harness.derivations == 1
    assert "v1" in harness.config[(live_reminder.SYSTEM_CLIENT_ID, live_reminder.STREAM_SCHEDULE_KEY)]["entries"]


def _real_freshness_read(monkeypatch):
    """The dispatcher's REAL _read_source_refreshed_at. The autouse conftest stub (and the Harness) replace it with "unknown", so undo every patch
    of this test first, take the original, and only then build the Harness -- which stubs it again; the caller restores the real one."""
    monkeypatch.undo()
    return notification_dispatcher._read_source_refreshed_at


def test_a_failing_freshness_read_degrades_to_unknown_and_never_stops_reminders(monkeypatch):
    """The wrapper turns ANY exception from the lifecycle read into "unknown" (the time-based fallback), so a store hiccup cannot silence reminders."""
    from tracking import livestream_lifecycle

    real_read = _real_freshness_read(monkeypatch)
    world = Harness(monkeypatch)
    world.add_client("c1", creator_reminders={"aizawa_ema": AT_START})
    world.refresh_snapshot([_stream()], SNAPSHOT_AT)
    monkeypatch.setattr(notification_dispatcher, "_read_source_refreshed_at", real_read)  # the real wrapper...
    monkeypatch.setattr(livestream_lifecycle, "read_display_refreshed_at", lambda: (_ for _ in ()).throw(RuntimeError("DynamoDB unavailable")))  # ...over a failing read

    assert real_read() is None
    world.run(START + timedelta(seconds=10))

    assert len(world.pushes) == 1  # the reminder still went out


def test_the_real_freshness_read_returns_the_lifecycles_value(monkeypatch):
    """The wrapper is a pass-through when the read works."""
    from tracking import livestream_lifecycle

    real_read = _real_freshness_read(monkeypatch)
    monkeypatch.setattr(livestream_lifecycle, "read_display_refreshed_at", lambda: SNAPSHOT_AT)

    assert real_read() == SNAPSHOT_AT


# ============ reschedules, cancellations, status changes ============


def test_a_reschedule_the_snapshot_already_carries_moves_the_notification_and_the_superseded_time_never_fires(harness):
    """The 21:15 stream is moved to 21:45 and the 12:10 snapshot says so: nothing at 21:15, one notification at 21:45."""
    harness.run(START - timedelta(minutes=8))  # derived from the :00 snapshot (start 21:15)
    new_start = START + timedelta(minutes=30)
    harness.refresh_snapshot([_stream(start=new_start)], SNAPSHOT_AT + timedelta(minutes=10))

    assert harness.run(START + timedelta(seconds=10))["delivered"] == 0  # the superseded 21:15 target is dead
    assert harness.run(new_start - timedelta(seconds=40))["delivered"] == 0
    assert harness.run(new_start + timedelta(seconds=10))["delivered"] == 1
    assert len(harness.pushes) == 1


def test_a_reschedule_the_snapshot_does_not_carry_yet_cannot_be_known_and_the_stored_time_is_used(harness):
    """The inherent freshness limit: Holodex reported nothing new by 21:15, so the stored 21:15 is the schedule -- documented, not hidden."""
    harness.run(START - timedelta(minutes=8))

    harness.run(START + timedelta(seconds=10))  # (the creator moved it at 21:12; the next snapshot is the :20 one)

    assert len(harness.pushes) == 1


def test_a_reschedule_after_the_notification_went_out_is_a_new_target_notified_once_at_its_new_time(harness):
    """The first delivery was for the superseded time; it neither blocks nor repeats. Same new target again -> still just once."""
    harness.run(START + timedelta(seconds=10))
    assert len(harness.pushes) == 1
    new_start = START + timedelta(minutes=30)
    harness.refresh_snapshot([_stream(start=new_start)], SNAPSHOT_AT + timedelta(minutes=20))

    harness.run(new_start + timedelta(seconds=10))
    harness.run(new_start + timedelta(seconds=40))  # an overlapping/retried run in the same window

    assert [push["data"]["videoId"] for push in harness.pushes] == ["v1", "v1"]
    assert len(harness.delivery) == 2  # two distinct targets, each recorded once


def test_a_cancelled_or_deleted_stream_stops_notifying_as_soon_as_the_snapshot_drops_it(harness):
    """Gone from the snapshot before its start: the derived schedule is replaced, so nothing is sent."""
    harness.run(START - timedelta(minutes=8))
    harness.refresh_snapshot([], SNAPSHOT_AT + timedelta(minutes=10))

    assert harness.run(START + timedelta(seconds=10))["delivered"] == 0
    assert harness.pushes == []


def test_a_stream_that_goes_from_upcoming_to_live_does_not_notify_twice(harness):
    """The start notification fired at its scheduled minute; the stream then goes LIVE (scheduledStart unchanged): no second one, ever."""
    harness.run(START + timedelta(seconds=10))
    assert len(harness.pushes) == 1

    harness.refresh_snapshot([_stream(status="live", actual=START + timedelta(minutes=2))], SNAPSHOT_AT + timedelta(minutes=10))
    for seconds in (130, 190, 250, 610, 1300):
        harness.run(START + timedelta(seconds=seconds))

    assert len(harness.pushes) == 1


def test_an_unscheduled_stream_keeps_its_existing_actual_start_behaviour(harness):
    """UNCHANGED, deliberately: a live stream with no scheduledStart is keyed by its actualStart and notified only if the dispatcher still finds it
    inside that start's one-minute window. With a 10-minute snapshot it is usually first seen later than that, so it usually is not -- exactly as it
    was with the old 15-minute derivation. Widening it is a separate product decision."""
    began = SNAPSHOT_AT + timedelta(minutes=10, seconds=-20)  # 12:09:40
    harness.refresh_snapshot([_stream("unscheduled", start=None, status="live", actual=began)], SNAPSHOT_AT + timedelta(minutes=10))

    assert harness.run(began + timedelta(minutes=2))["delivered"] == 0  # first seen after its window closed: not notified

    other = SNAPSHOT_AT + timedelta(minutes=30)
    harness.refresh_snapshot([_stream("unscheduled2", start=None, status="live", actual=other)], other + timedelta(seconds=5))
    assert harness.run(other + timedelta(seconds=20))["delivered"] == 1  # seen inside its window: notified, once
    assert harness.run(other + timedelta(seconds=50))["delivered"] == 0


# ============ idempotency and retries ============


def test_overlapping_invocations_that_both_pass_the_pre_check_send_exactly_once(harness):
    """The atomic claim, not the pre-check, is what prevents the double send: two runs racing on the same (client, stream, target)."""
    harness.blind_precheck = True

    first = harness.run(START + timedelta(seconds=10))
    second = harness.run(START + timedelta(seconds=11))

    assert first["delivered"] + second["delivered"] == 1
    assert len(harness.pushes) == 1


def test_a_failed_send_releases_the_claim_so_a_retry_in_the_window_delivers_once(harness):
    """Transient push failure -> nothing is marked delivered; the next run still inside the minute sends it; later runs add nothing."""
    harness.push_results = [PushResult(sent=False, subscription_expired=False, error="503 from the push service")]

    assert harness.run(START + timedelta(seconds=10))["delivered"] == 0
    assert harness.delivery == {}  # released
    assert harness.run(START + timedelta(seconds=40))["delivered"] == 1
    assert harness.run(START + timedelta(seconds=55))["delivered"] == 0

    assert [push["sent"] for push in harness.pushes] == [False, True]


def test_an_expired_subscription_is_not_counted_as_delivered_and_does_not_raise(harness):
    """Cleanup of an expired subscription is left to a later pass; the dispatcher itself keeps going."""
    harness.push_results = [PushResult(sent=False, subscription_expired=True, error="410 Gone")]

    assert harness.run(START + timedelta(seconds=10))["delivered"] == 0
    assert harness.delivery == {}


def test_a_redeploy_cannot_resend_what_an_older_version_just_delivered(harness):
    """The previous version deduped under {videoId}:reminder:{kind} (no start time). A row it wrote moments ago, for this very start, still blocks:
    switching the key at the redeploy minute can never send the same reminder twice."""
    harness.delivery[("c1", "v1:reminder:start")] = {"status": "delivered", "at": (START + timedelta(seconds=5)).isoformat()}

    assert harness.run(START + timedelta(seconds=10))["delivered"] == 0
    assert harness.pushes == []


def test_an_old_legacy_row_never_blocks_a_rescheduled_stream(harness):
    """A legacy row from hours ago was for a start the stream has since moved away from: it must not suppress the new target (a pre-deploy
    delivery of v1's start for 18:15, then v1 moved to 21:15 -- the new start is still notified)."""
    harness.delivery[("c1", "v1:reminder:start")] = {"status": "delivered", "at": (START - timedelta(hours=3)).isoformat()}

    assert harness.run(START + timedelta(seconds=10))["delivered"] == 1


def test_seconds_of_jitter_in_a_reported_start_never_create_a_second_target(harness):
    """Targets are per MINUTE: a snapshot that restates the same start a few seconds off is the same target, so nothing is sent twice."""
    harness.run(START + timedelta(seconds=10))
    assert len(harness.pushes) == 1
    harness.refresh_snapshot([_stream(start=START + timedelta(seconds=40))], SNAPSHOT_AT + timedelta(minutes=10))  # same minute, other seconds

    harness.run(START + timedelta(seconds=50))

    assert len(harness.pushes) == 1


def test_the_dispatcher_through_the_real_read_path_never_reaches_holodex(monkeypatch):
    """The Harness replaces get_live_streams, so on its own it cannot prove the claim. Here the REAL read_api.get_live_streams runs over a persisted
    shared snapshot (the DynamoDB backend), with the Holodex boundary a tripwire: the whole dispatcher run makes zero upstream requests."""
    world = Harness(monkeypatch)  # stores, push sender and the Holodex tripwire ...
    world.add_client("c1", creator_reminders={"aizawa_ema": AT_START})
    monkeypatch.setattr(read_api, "get_live_streams", read_api_real_get_live_streams)  # ... but the REAL read path instead of the harness' stub
    monkeypatch.setenv("YOBI_STORAGE_BACKEND", "dynamodb")
    monkeypatch.setattr(read_api, "_read_shared_live_snapshot", lambda: [_stream()])  # the persisted shared snapshot
    monkeypatch.setattr(read_api, "_read_recently_ended", lambda: None)
    monkeypatch.setattr(read_api, "_without_known_non_livestreams", lambda streams: streams)

    summary = world.run(START + timedelta(seconds=10))

    assert summary["delivered"] == 1  # the stored schedule came through the real read path


def test_the_dedupe_key_names_the_reminder_kind_and_the_scheduled_start_it_is_for():
    """The pure key shape: new (kind + target minute) and legacy (kind only)."""
    assert notification_dispatcher._reminder_dedupe_ids("v1", notification_text.KIND_START, 120_000) == ("v1:reminder:start@2", "v1:reminder:start")
    assert notification_dispatcher._reminder_dedupe_ids("v1", notification_text.KIND_ADVANCE, 179_999) == ("v1:reminder:advance@2", "v1:reminder:advance")  # to the minute


def test_the_dispatcher_survives_a_run_with_no_streams_no_subscribers_and_no_snapshot_at_all(harness):
    """Fresh deploy / empty store: a clean no-op, not a crash."""
    harness.config.clear()
    harness.snapshot, harness.snapshot_at = [], None

    assert harness.run(START)["delivered"] == 0
