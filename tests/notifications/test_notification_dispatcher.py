from datetime import datetime, timezone

import pytest

from stores import notification_delivery_log_store
from notifications import notification_dispatcher
from stores import notification_events_store
from notifications import live_reminder
from notifications import push_sender
from stores import remote_config_store
from api import read_api
from tracking.creator_master import Creator
from notifications.notification_dispatcher import lambda_handler
from notifications.push_sender import PushResult


def _creator(**overrides) -> Creator:
    fields = {
        "creator_id": "aizawa_ema",
        "display_name": "藍沢エマ",
        "organization": "vspo",
        "youtube_channel_id": "UC_test",
        "active": True,
        "branch": "vspo_jp",
        "group_key": ["1期生"],
        "channel_type": "member",
        "lifecycle_stage": "active",
        "display_order": 0,
    }
    fields.update(overrides)
    return Creator(**fields)


def _event_item(**overrides) -> dict:
    fields = {
        "eventDate": "2026-09-03",
        "videoId": "v1",
        "creatorId": "aizawa_ema",
        "title": "New Video",
        "discoveredAt": "2026-09-03T18:00:00+09:00",
    }
    fields.update(overrides)
    return fields


def _preference_value(**overrides) -> dict:
    fields = {
        "enabled": True,
        "notificationLevel": "all",
        "temporaryMute": None,
        "creatorOverride": {},
        "notificationTimeZone": "Asia/Tokyo",
        "deliveryWindows": ["08:00", "18:00"],
        "quietHours": None,
    }
    fields.update(overrides)
    return fields


def _subscription_value() -> dict:
    return {
        "endpoint": "https://fcm.googleapis.com/fcm/send/abc123",
        "keys": {"p256dh": "p256dh-key", "auth": "auth-key"},
    }


def _override_value(**overrides) -> dict:
    """A stream override's stored shape -- notification preference only, no
    scheduledStartMs (that always comes from the system-wide streamSchedule
    snapshot instead, see _schedule_value)."""
    fields = {"creatorId": "aizawa_ema", "notifyAtStart": True, "advanceReminder": "30min"}
    fields.update(overrides)
    return fields


def _creator_reminder_value(**overrides) -> dict:
    fields = {"notifyAtStart": True, "advanceReminder": "30min"}
    fields.update(overrides)
    return fields


def _schedule_value(entries: dict, *, refreshed_at: datetime) -> dict:
    """The system-wide streamSchedule record's stored shape, fresh as of
    refreshed_at -- pass the SAME `now` a test uses for notification_dispatcher's
    frozen clock so the staleness check always finds it fresh, unless the
    test is specifically about staleness."""
    return {"entries": entries, "refreshedAt": refreshed_at.isoformat()}


def _remote_config_stub(*, subscription=None, overrides=None, creator_reminders=None, schedule=None):
    """A get_remote_config stand-in that returns a different stored value
    per key, mirroring the real store (unlike most of this file's existing
    single-value-regardless-of-key lambdas, which only ever exercise the
    discovery-event path and never reach the reminder lookup below it)."""

    def _get(client_id: str, key: str):
        if key == notification_dispatcher._PUSH_SUBSCRIPTION_KEY:
            return {"value": subscription} if subscription is not None else None
        if key == live_reminder.STREAM_NOTIFICATION_OVERRIDES_KEY:
            return {"value": overrides} if overrides is not None else None
        if key == live_reminder.CREATOR_LIVE_REMINDERS_KEY:
            return {"value": creator_reminders} if creator_reminders is not None else None
        if key == live_reminder.STREAM_SCHEDULE_KEY:
            return {"value": schedule} if schedule is not None else None
        return None

    return _get


@pytest.fixture(autouse=True)
def stub_vapid(monkeypatch):
    """No real VAPID credentials needed — push_sender itself is stubbed in every test."""
    monkeypatch.setattr(notification_dispatcher, "get_vapid_credentials", lambda: ("pem", {"sub": "mailto:a@b.com"}))


@pytest.fixture(autouse=True)
def stub_creators(monkeypatch):
    monkeypatch.setattr(notification_dispatcher, "load_creators", lambda: [_creator()])


@pytest.fixture(autouse=True)
def stub_live_streams(monkeypatch):
    """Every test gets an empty Holodex live/upcoming snapshot and skips the
    real remote-config read/write _refresh_and_load_stream_schedule would
    otherwise do, unless the test overrides get_live_streams/get_remote_config
    itself -- none of this file's existing (pre-reminder) tests exercise the
    normal-stream reminder path, so there's nothing for them to assert about
    the schedule snapshot."""
    monkeypatch.setattr(read_api, "get_live_streams", lambda *_a, **_kw: {"streams": []})
    # _refresh_and_load_stream_schedule persists its fresh (here: empty)
    # snapshot every run -- a real write isn't relevant to any of this
    # file's existing tests, so it's a no-op unless a test overrides it.
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: None)


def test_no_recent_events_and_no_reminder_data_reports_nothing_checked_or_delivered(monkeypatch):
    """Preferences ARE still looked up even with zero discovery events --
    unlike before the single-stream/creator live-reminder work, "no recent
    events" no longer means "nothing else to check": a creator's recurring
    reminder or a stream override can still be due independent of the
    discovery-event loop. With no stored reminder data either, there is
    genuinely nothing to deliver."""
    monkeypatch.setattr(notification_events_store, "list_events_for_date", lambda event_date: [])
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": _preference_value()}])
    monkeypatch.setattr(remote_config_store, "get_remote_config", _remote_config_stub(subscription=_subscription_value()))

    response = lambda_handler({}, None)

    assert response == {"statusCode": 200, "checked": 0, "delivered": 0}


def test_delivers_a_due_event_to_a_subscribed_eligible_client(monkeypatch):
    # Discovered at yesterday's 18:00 JST run; now is today 18:05 JST, so
    # today's 08:00/18:00 windows have both already passed the event's own
    # next-eligible-window instant (tomorrow-relative-to-discovery 08:00).
    now = datetime(2026, 9, 3, 9, 5, tzinfo=timezone.utc)  # 18:05 JST
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(now))
    monkeypatch.setattr(
        notification_events_store,
        "list_events_for_date",
        lambda event_date: [_event_item(eventDate="2026-09-02", discoveredAt="2026-09-02T18:00:00+09:00")]
        if event_date == "2026-09-02"
        else [],
    )
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": _preference_value()}])
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: {"value": _subscription_value()})
    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", lambda client_id, video_id: False)
    monkeypatch.setattr(notification_delivery_log_store, "mark_delivered", lambda client_id, video_id, delivered_at: True)
    confirmed = {}
    monkeypatch.setattr(
        notification_delivery_log_store,
        "confirm_delivered",
        lambda client_id, video_id, delivered_at: confirmed.update(client_id=client_id, video_id=video_id),
    )
    monkeypatch.setattr(push_sender, "send_push_notification", lambda *a, **kw: PushResult(sent=True, subscription_expired=False))

    response = lambda_handler({}, None)

    assert response == {"statusCode": 200, "checked": 1, "delivered": 1}
    assert confirmed == {"client_id": "c1", "video_id": "v1"}


def test_does_not_redeliver_an_already_delivered_event(monkeypatch):
    now = datetime(2026, 9, 3, 9, 5, tzinfo=timezone.utc)
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(now))
    monkeypatch.setattr(
        notification_events_store,
        "list_events_for_date",
        lambda event_date: [_event_item(eventDate="2026-09-02", discoveredAt="2026-09-02T18:00:00+09:00")]
        if event_date == "2026-09-02"
        else [],
    )
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": _preference_value()}])
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: {"value": _subscription_value()})
    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", lambda client_id, video_id: True)

    def _boom(*a, **kw):
        raise AssertionError("should never send a push for an already-delivered event")

    monkeypatch.setattr(push_sender, "send_push_notification", _boom)

    response = lambda_handler({}, None)

    assert response == {"statusCode": 200, "checked": 1, "delivered": 0}


def test_a_lost_delivery_claim_race_does_not_send_a_push(monkeypatch):
    """Two overlapping dispatcher runs can both pass already_delivered()'s
    cheap pre-check before either has written anything — mark_delivered's
    atomic conditional write is the actual race gate. Simulates the loser:
    the claim call itself returns False, so this run must not send."""
    now = datetime(2026, 9, 3, 9, 5, tzinfo=timezone.utc)
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(now))
    monkeypatch.setattr(
        notification_events_store,
        "list_events_for_date",
        lambda event_date: [_event_item(eventDate="2026-09-02", discoveredAt="2026-09-02T18:00:00+09:00")]
        if event_date == "2026-09-02"
        else [],
    )
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": _preference_value()}])
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: {"value": _subscription_value()})
    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", lambda client_id, video_id: False)
    monkeypatch.setattr(notification_delivery_log_store, "mark_delivered", lambda client_id, video_id, delivered_at: False)

    def _boom(*a, **kw):
        raise AssertionError("should never send a push after losing the atomic delivery claim")

    monkeypatch.setattr(push_sender, "send_push_notification", _boom)

    response = lambda_handler({}, None)

    assert response == {"statusCode": 200, "checked": 1, "delivered": 0}


def test_holds_an_event_until_its_next_delivery_window(monkeypatch):
    """Discovered at 18:00:05 JST with windows [08:00, 18:00] — the next
    eligible window is tomorrow 08:00, so a run at 20:00 JST the same day
    must not deliver it yet."""
    now = datetime(2026, 9, 3, 11, 0, tzinfo=timezone.utc)  # 20:00 JST
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(now))
    monkeypatch.setattr(
        notification_events_store,
        "list_events_for_date",
        lambda event_date: [_event_item(discoveredAt="2026-09-03T18:00:05+09:00")] if event_date == "2026-09-03" else [],
    )
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": _preference_value()}])
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: {"value": _subscription_value()})
    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", lambda client_id, video_id: False)

    def _boom(*a, **kw):
        raise AssertionError("should not send before the next eligible delivery window")

    monkeypatch.setattr(push_sender, "send_push_notification", _boom)

    response = lambda_handler({}, None)

    assert response == {"statusCode": 200, "checked": 1, "delivered": 0}


def test_suppressed_client_is_skipped_without_sending(monkeypatch):
    now = datetime(2026, 9, 3, 9, 5, tzinfo=timezone.utc)
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(now))
    monkeypatch.setattr(
        notification_events_store,
        "list_events_for_date",
        lambda event_date: [_event_item(eventDate="2026-09-02", discoveredAt="2026-09-02T18:00:00+09:00")]
        if event_date == "2026-09-02"
        else [],
    )
    monkeypatch.setattr(
        remote_config_store,
        "list_by_key",
        lambda key: [{"clientId": "c1", "value": _preference_value(creatorOverride={"aizawa_ema": False})}],
    )
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: {"value": _subscription_value()})
    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", lambda client_id, video_id: False)

    def _boom(*a, **kw):
        raise AssertionError("should not send to a client whose creator override disables this creator")

    monkeypatch.setattr(push_sender, "send_push_notification", _boom)

    response = lambda_handler({}, None)

    assert response == {"statusCode": 200, "checked": 1, "delivered": 0}


def test_client_with_no_push_subscription_is_skipped(monkeypatch):
    now = datetime(2026, 9, 3, 9, 5, tzinfo=timezone.utc)
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(now))
    monkeypatch.setattr(
        notification_events_store, "list_events_for_date", lambda event_date: [_event_item()] if event_date == "2026-09-03" else []
    )
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": _preference_value()}])
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: None)

    def _boom(*a, **kw):
        raise AssertionError("should not touch delivery state for a client with no stored subscription")

    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", _boom)

    response = lambda_handler({}, None)

    assert response == {"statusCode": 200, "checked": 0, "delivered": 0}


def test_client_with_an_invalid_stored_preference_is_skipped(monkeypatch):
    now = datetime(2026, 9, 3, 9, 5, tzinfo=timezone.utc)
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(now))
    monkeypatch.setattr(
        notification_events_store, "list_events_for_date", lambda event_date: [_event_item()] if event_date == "2026-09-03" else []
    )
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": {"enabled": "not-a-bool"}}])

    def _boom(client_id, key):
        # The schedule-staleness check (SYSTEM_CLIENT_ID) runs once per
        # dispatcher invocation regardless of any individual client's own
        # preference validity -- only a per-CLIENT lookup is forbidden here.
        if client_id == live_reminder.SYSTEM_CLIENT_ID:
            return None
        raise AssertionError("should not look up a subscription for a client with an invalid preference")

    monkeypatch.setattr(remote_config_store, "get_remote_config", _boom)

    response = lambda_handler({}, None)

    assert response == {"statusCode": 200, "checked": 0, "delivered": 0}


def test_expired_subscription_releases_its_delivery_claim(monkeypatch):
    """A claim is taken before sending (the atomicity fix); an expired
    subscription means the send didn't actually happen, so the claim must
    be released rather than left standing as a phantom delivered record."""
    now = datetime(2026, 9, 3, 9, 5, tzinfo=timezone.utc)
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(now))
    monkeypatch.setattr(
        notification_events_store,
        "list_events_for_date",
        lambda event_date: [_event_item(eventDate="2026-09-02", discoveredAt="2026-09-02T18:00:00+09:00")]
        if event_date == "2026-09-02"
        else [],
    )
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": _preference_value()}])
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: {"value": _subscription_value()})
    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", lambda client_id, video_id: False)
    monkeypatch.setattr(notification_delivery_log_store, "mark_delivered", lambda client_id, video_id, delivered_at: True)
    released = {}
    monkeypatch.setattr(
        notification_delivery_log_store,
        "release_claim",
        lambda client_id, video_id: released.update(client_id=client_id, video_id=video_id),
    )
    monkeypatch.setattr(push_sender, "send_push_notification", lambda *a, **kw: PushResult(sent=False, subscription_expired=True))

    response = lambda_handler({}, None)

    assert response == {"statusCode": 200, "checked": 1, "delivered": 0}
    assert released == {"client_id": "c1", "video_id": "v1"}


def test_a_failed_send_releases_its_delivery_claim(monkeypatch):
    now = datetime(2026, 9, 3, 9, 5, tzinfo=timezone.utc)
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(now))
    monkeypatch.setattr(
        notification_events_store,
        "list_events_for_date",
        lambda event_date: [_event_item(eventDate="2026-09-02", discoveredAt="2026-09-02T18:00:00+09:00")]
        if event_date == "2026-09-02"
        else [],
    )
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": _preference_value()}])
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: {"value": _subscription_value()})
    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", lambda client_id, video_id: False)
    monkeypatch.setattr(notification_delivery_log_store, "mark_delivered", lambda client_id, video_id, delivered_at: True)
    released = {}
    monkeypatch.setattr(
        notification_delivery_log_store,
        "release_claim",
        lambda client_id, video_id: released.update(client_id=client_id, video_id=video_id),
    )
    monkeypatch.setattr(
        push_sender, "send_push_notification", lambda *a, **kw: PushResult(sent=False, subscription_expired=False, error="network")
    )

    response = lambda_handler({}, None)

    assert response == {"statusCode": 200, "checked": 1, "delivered": 0}
    assert released == {"client_id": "c1", "video_id": "v1"}


# --- single-stream live-reminder dispatch (creatorLiveReminders /
# streamNotificationOverrides, live_reminder.py) -------------------------


def _harmless_discovery_event():
    """One already-delivered discovery event so _recent_events is non-empty
    (lambda_handler short-circuits to {checked: 0, delivered: 0} otherwise,
    before even loading preferences) -- these reminder tests are only
    interested in the stream-override loop below it, not this one."""
    return _event_item(videoId="unrelated_v0")


def test_sends_a_due_start_and_advance_reminder_independently_in_the_same_run(monkeypatch):
    """Spec section 1/8: notify-at-start and the advance reminder are
    independent, both-can-apply dimensions -- both fire in one run when both
    are due. scheduledStartMs now comes from the system-wide schedule
    snapshot, never from the override itself (item 1 of this round's spec)."""
    scheduled_start_ms = 1_000_000_000_000
    advance_fire_at_ms = scheduled_start_ms - 30 * 60_000
    now = datetime.fromtimestamp(scheduled_start_ms / 1000, tz=timezone.utc)
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(now))
    monkeypatch.setattr(notification_events_store, "list_events_for_date", lambda event_date: [_harmless_discovery_event()])
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": _preference_value()}])
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        _remote_config_stub(
            subscription=_subscription_value(),
            overrides={"v1": _override_value(advanceReminder="30min")},
            schedule=_schedule_value({"v1": {"creatorId": "aizawa_ema", "scheduledStartMs": scheduled_start_ms}}, refreshed_at=now),
        ),
    )

    def _already_delivered(client_id, video_id):
        return video_id == "unrelated_v0"  # the harmless discovery event only

    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", _already_delivered)
    monkeypatch.setattr(notification_delivery_log_store, "mark_delivered", lambda client_id, video_id, delivered_at: True)
    monkeypatch.setattr(notification_delivery_log_store, "confirm_delivered", lambda client_id, video_id, delivered_at: None)
    sent_titles = []
    monkeypatch.setattr(
        push_sender,
        "send_push_notification",
        lambda *a, **kw: (sent_titles.append(kw["title"]), PushResult(sent=True, subscription_expired=False))[1],
    )

    response = lambda_handler({}, None)

    # now sits exactly at scheduled_start_ms -- both the start window
    # ([scheduled_start_ms, +1min)) and nothing else fire at this instant;
    # re-run at the advance fire instant to prove that one fires too. The
    # schedule snapshot's own refreshedAt is re-pinned to each new `now` so
    # the staleness check (this round's item 2) doesn't itself trigger an
    # (unstubbed) Holodex call mid-test.
    assert response["delivered"] == 1
    assert "is live now" in sent_titles[0]

    advance_now = datetime.fromtimestamp(advance_fire_at_ms / 1000, tz=timezone.utc)
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(advance_now))
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        _remote_config_stub(
            subscription=_subscription_value(),
            overrides={"v1": _override_value(advanceReminder="30min")},
            schedule=_schedule_value({"v1": {"creatorId": "aizawa_ema", "scheduledStartMs": scheduled_start_ms}}, refreshed_at=advance_now),
        ),
    )
    sent_titles.clear()
    response = lambda_handler({}, None)
    assert response["delivered"] == 1
    assert "starting soon" in sent_titles[0]


def test_creator_disabled_override_still_prevents_reminder_delivery(monkeypatch):
    """Spec section 12: notify_at_start/advanceReminder are additional info
    for an ENABLED creator -- a disabled creator must not get a reminder
    just because a stream override exists."""
    scheduled_start_ms = 1_000_000_000_000
    now = datetime.fromtimestamp(scheduled_start_ms / 1000, tz=timezone.utc)
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(now))
    monkeypatch.setattr(notification_events_store, "list_events_for_date", lambda event_date: [_harmless_discovery_event()])
    monkeypatch.setattr(
        remote_config_store,
        "list_by_key",
        lambda key: [{"clientId": "c1", "value": _preference_value(creatorOverride={"aizawa_ema": False})}],
    )
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        _remote_config_stub(
            subscription=_subscription_value(),
            overrides={"v1": _override_value()},
            schedule=_schedule_value({"v1": {"creatorId": "aizawa_ema", "scheduledStartMs": scheduled_start_ms}}, refreshed_at=now),
        ),
    )
    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", lambda client_id, video_id: video_id == "unrelated_v0")

    def _boom(*a, **kw):
        raise AssertionError("should not send a reminder to a client whose creator override disables this creator")

    monkeypatch.setattr(push_sender, "send_push_notification", _boom)

    response = lambda_handler({}, None)

    assert response["delivered"] == 0


def test_reminder_dedupe_prevents_resending_the_same_reminder_kind(monkeypatch):
    """Spec section 9: clientId + videoId + reminder kind is its own dedupe
    identity, independent of the discovery-notification dedupe above it."""
    scheduled_start_ms = 1_000_000_000_000
    now = datetime.fromtimestamp(scheduled_start_ms / 1000, tz=timezone.utc)
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(now))
    monkeypatch.setattr(notification_events_store, "list_events_for_date", lambda event_date: [_harmless_discovery_event()])
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": _preference_value()}])
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        _remote_config_stub(
            subscription=_subscription_value(),
            overrides={"v1": _override_value()},
            schedule=_schedule_value({"v1": {"creatorId": "aizawa_ema", "scheduledStartMs": scheduled_start_ms}}, refreshed_at=now),
        ),
    )
    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", lambda client_id, video_id: video_id == "v1:reminder:start")

    def _boom(*a, **kw):
        raise AssertionError("should not resend an already-delivered reminder kind")

    monkeypatch.setattr(push_sender, "send_push_notification", _boom)

    response = lambda_handler({}, None)

    assert response["delivered"] == 0


def test_reminder_uses_the_system_schedules_scheduled_start_not_the_unrelated_discovery_event(monkeypatch):
    """Spec section 7/item H: scheduledStartMs (from the streamSchedule
    snapshot), never discoveredAt, drives reminder timing -- discoveredAt
    here is set far away from scheduled_start_ms and must have no bearing on
    the result."""
    scheduled_start_ms = 1_000_000_000_000
    now = datetime.fromtimestamp(scheduled_start_ms / 1000, tz=timezone.utc)
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(now))
    monkeypatch.setattr(
        notification_events_store,
        "list_events_for_date",
        lambda event_date: [_event_item(videoId="unrelated_v0", discoveredAt="2000-01-01T00:00:00+09:00")],
    )
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": _preference_value()}])
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        _remote_config_stub(
            subscription=_subscription_value(),
            overrides={"v1": _override_value()},
            schedule=_schedule_value({"v1": {"creatorId": "aizawa_ema", "scheduledStartMs": scheduled_start_ms}}, refreshed_at=now),
        ),
    )
    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", lambda client_id, video_id: video_id == "unrelated_v0")
    monkeypatch.setattr(notification_delivery_log_store, "mark_delivered", lambda client_id, video_id, delivered_at: True)
    delivered_video_ids = []
    monkeypatch.setattr(
        push_sender,
        "send_push_notification",
        lambda *a, **kw: PushResult(sent=True, subscription_expired=False),
    )
    monkeypatch.setattr(
        notification_delivery_log_store,
        "confirm_delivered",
        lambda client_id, video_id, delivered_at: delivered_video_ids.append(video_id),
    )

    response = lambda_handler({}, None)

    assert response["delivered"] == 1
    assert delivered_video_ids == ["v1:reminder:start"]


def test_rescheduling_a_stream_after_its_override_was_saved_moves_the_reminder_with_it(monkeypatch):
    """This round's item 1/required-test-2: an override does NOT freeze
    scheduledStartMs. Stream A originally scheduled 18:00 (UTC), override
    saved as start+1hour -- Holodex later reschedules it to 20:00. The
    effective reminder must follow the NEW 20:00 time (19:00 advance, 20:00
    start), never still fire against the stale 18:00 timestamp."""
    old_start_ms = 1_000_000_000_000
    new_start_ms = old_start_ms + 2 * 60 * 60_000  # +2h, e.g. 18:00 -> 20:00
    new_advance_fire_at_ms = new_start_ms - 60 * 60_000  # 19:00

    monkeypatch.setattr(notification_events_store, "list_events_for_date", lambda event_date: [_harmless_discovery_event()])
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": _preference_value()}])
    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", lambda client_id, video_id: video_id == "unrelated_v0")

    def _boom(*a, **kw):
        raise AssertionError("must not fire against the stale pre-reschedule 18:00 timestamp")

    monkeypatch.setattr(push_sender, "send_push_notification", _boom)

    # At the OLD schedule's own start instant, after it's been rescheduled
    # (the snapshot now only knows the NEW 20:00 time) -- must NOT fire.
    old_now = datetime.fromtimestamp(old_start_ms / 1000, tz=timezone.utc)
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(old_now))
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        _remote_config_stub(
            subscription=_subscription_value(),
            overrides={"v1": _override_value(advanceReminder="1hour")},
            schedule=_schedule_value({"v1": {"creatorId": "aizawa_ema", "scheduledStartMs": new_start_ms}}, refreshed_at=old_now),
        ),
    )
    response = lambda_handler({}, None)
    assert response["delivered"] == 0

    # At the NEW schedule's own 1-hour-before instant (19:00) -- must fire,
    # using the SAME still-unchanged override.
    monkeypatch.setattr(push_sender, "send_push_notification", lambda *a, **kw: PushResult(sent=True, subscription_expired=False))
    monkeypatch.setattr(notification_delivery_log_store, "mark_delivered", lambda client_id, video_id, delivered_at: True)
    monkeypatch.setattr(notification_delivery_log_store, "confirm_delivered", lambda client_id, video_id, delivered_at: None)
    advance_now = datetime.fromtimestamp(new_advance_fire_at_ms / 1000, tz=timezone.utc)
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(advance_now))
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        _remote_config_stub(
            subscription=_subscription_value(),
            overrides={"v1": _override_value(advanceReminder="1hour")},
            schedule=_schedule_value({"v1": {"creatorId": "aizawa_ema", "scheduledStartMs": new_start_ms}}, refreshed_at=advance_now),
        ),
    )
    response = lambda_handler({}, None)
    assert response["delivered"] == 1


# --- normal (never-overridden) streams: creator recurring reminder must work
# without the browser/Schedule ever having been involved ------------------


def _holodex_stream(**overrides) -> dict:
    fields = {
        "videoId": "v2",
        "creatorId": "aizawa_ema",
        "channelName": "藍沢エマ",
        "title": "Ranked grind",
        "status": "upcoming",
        "scheduledStart": "2001-09-09T01:46:40+00:00",  # 1_000_000_000_000 ms
        "actualStart": None,
        "thumbnailUrl": None,
    }
    fields.update(overrides)
    return fields


def test_a_normal_stream_with_no_override_gets_both_reminders_from_the_system_wide_schedule(monkeypatch):
    """Item A: creator recurring start+30min; a stream NO client ever opened
    Schedule for, or saved an override for, still gets both its advance and
    start reminder -- sourced entirely from the system-wide schedule
    snapshot this run itself refreshes from Holodex, never from any
    client's own saved data."""
    scheduled_start_ms = 1_000_000_000_000
    advance_fire_at_ms = scheduled_start_ms - 30 * 60_000
    monkeypatch.setattr(read_api, "get_live_streams", lambda *_a, **_kw: {"streams": [_holodex_stream()]})
    monkeypatch.setattr(notification_events_store, "list_events_for_date", lambda event_date: [_harmless_discovery_event()])
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": _preference_value()}])
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        _remote_config_stub(subscription=_subscription_value(), creator_reminders={"aizawa_ema": _creator_reminder_value(advanceReminder="30min")}),
    )
    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", lambda client_id, video_id: video_id == "unrelated_v0")
    monkeypatch.setattr(notification_delivery_log_store, "mark_delivered", lambda client_id, video_id, delivered_at: True)
    monkeypatch.setattr(notification_delivery_log_store, "confirm_delivered", lambda client_id, video_id, delivered_at: None)
    sent = []
    monkeypatch.setattr(push_sender, "send_push_notification", lambda *a, **kw: (sent.append(kw["data"]), PushResult(sent=True, subscription_expired=False))[1])

    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(datetime.fromtimestamp(advance_fire_at_ms / 1000, tz=timezone.utc)))
    response = lambda_handler({}, None)
    assert response["delivered"] == 1
    assert sent[-1] == {"videoId": "v2", "reminderKind": "advance"}

    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(datetime.fromtimestamp(scheduled_start_ms / 1000, tz=timezone.utc)))
    response = lambda_handler({}, None)
    assert response["delivered"] == 1
    assert sent[-1] == {"videoId": "v2", "reminderKind": "start"}


def test_stream_a_override_suppresses_the_creators_30min_reminder_for_that_stream(monkeypatch):
    """Item B: Stream A has its own override (start+1hour). Even though it
    also appears in the system-wide schedule for a creator whose recurring
    setting is 30min, the creator's 30min must NOT also fire for Stream A --
    override replaces, never adds to, the creator setting."""
    scheduled_start_ms = 1_000_000_000_000
    advance_30min_fire_at_ms = scheduled_start_ms - 30 * 60_000
    monkeypatch.setattr(read_api, "get_live_streams", lambda *_a, **_kw: {"streams": [_holodex_stream(videoId="v1")]})
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(datetime.fromtimestamp(advance_30min_fire_at_ms / 1000, tz=timezone.utc)))
    monkeypatch.setattr(notification_events_store, "list_events_for_date", lambda event_date: [_harmless_discovery_event()])
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": _preference_value()}])
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        _remote_config_stub(
            subscription=_subscription_value(),
            overrides={"v1": _override_value(scheduledStartMs=scheduled_start_ms, advanceReminder="1hour")},
            creator_reminders={"aizawa_ema": _creator_reminder_value(advanceReminder="30min")},
        ),
    )
    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", lambda client_id, video_id: video_id == "unrelated_v0")

    def _boom(*a, **kw):
        raise AssertionError("the creator's 30min reminder must not fire for an overridden stream")

    monkeypatch.setattr(push_sender, "send_push_notification", _boom)

    response = lambda_handler({}, None)

    assert response["delivered"] == 0


def test_stream_b_with_no_override_still_resolves_the_creators_recurring_setting(monkeypatch):
    """Item C: a second, different stream from the same creator (no override
    of its own) keeps using the creator's 30min recurring setting."""
    scheduled_start_ms = 2_000_000_000_000
    advance_fire_at_ms = scheduled_start_ms - 30 * 60_000
    monkeypatch.setattr(
        read_api, "get_live_streams", lambda *_a, **_kw: {"streams": [_holodex_stream(videoId="v3", scheduledStart="2033-05-18T03:33:20+00:00")]}
    )
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(datetime.fromtimestamp(advance_fire_at_ms / 1000, tz=timezone.utc)))
    monkeypatch.setattr(notification_events_store, "list_events_for_date", lambda event_date: [_harmless_discovery_event()])
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": _preference_value()}])
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        _remote_config_stub(subscription=_subscription_value(), creator_reminders={"aizawa_ema": _creator_reminder_value(advanceReminder="30min")}),
    )
    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", lambda client_id, video_id: video_id == "unrelated_v0")
    monkeypatch.setattr(notification_delivery_log_store, "mark_delivered", lambda client_id, video_id, delivered_at: True)
    monkeypatch.setattr(notification_delivery_log_store, "confirm_delivered", lambda client_id, video_id, delivered_at: None)
    sent = []
    monkeypatch.setattr(push_sender, "send_push_notification", lambda *a, **kw: (sent.append(kw["data"]), PushResult(sent=True, subscription_expired=False))[1])

    response = lambda_handler({}, None)

    assert response["delivered"] == 1
    assert sent[-1] == {"videoId": "v3", "reminderKind": "advance"}


def test_schedule_snapshot_refreshes_on_every_run_independent_of_any_saved_override(monkeypatch):
    """Item D: the system-wide schedule is persisted purely as a side effect
    of this dispatcher running -- no client needs to have ever saved a
    stream override or a creator recurring reminder."""
    monkeypatch.setattr(read_api, "get_live_streams", lambda *_a, **_kw: {"streams": [_holodex_stream()]})
    monkeypatch.setattr(notification_events_store, "list_events_for_date", lambda event_date: [])
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [])  # no client has any preference at all
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: None)  # no prior snapshot -- always stale
    written = {}
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: written.update(record))

    lambda_handler({}, None)

    assert written["clientId"] == live_reminder.SYSTEM_CLIENT_ID
    assert written["key"] == live_reminder.STREAM_SCHEDULE_KEY
    assert written["value"]["entries"] == {"v2": {"creatorId": "aizawa_ema", "scheduledStartMs": 1_000_000_000_000}}


def test_stale_schedule_entries_are_dropped_on_the_next_successful_refresh(monkeypatch):
    """Item E: a bounded lifecycle with no separate expiry bookkeeping --
    each successful refresh is a full replace, so a stream Holodex stops
    returning (ended, or aged out of its own upcoming window) disappears
    from the stored snapshot on the very next refresh."""
    written = {}
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: written.update(record))
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: {"value": written["value"]} if written else None)

    old_now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    monkeypatch.setattr(read_api, "get_live_streams", lambda *_a, **_kw: {"streams": [_holodex_stream(videoId="v_old")]})
    first = notification_dispatcher._refresh_and_load_stream_schedule(now=old_now)
    assert "v_old" in first

    # Far enough past old_now + _SCHEDULE_REFRESH_INTERVAL that the first
    # snapshot is treated as stale, forcing a real second refresh.
    new_now = old_now + notification_dispatcher._SCHEDULE_REFRESH_INTERVAL * 2
    monkeypatch.setattr(read_api, "get_live_streams", lambda *_a, **_kw: {"streams": [_holodex_stream(videoId="v_new")]})
    second = notification_dispatcher._refresh_and_load_stream_schedule(now=new_now)
    assert "v_old" not in second
    assert "v_new" in second


def test_a_failed_holodex_refresh_keeps_the_previous_schedule_instead_of_wiping_it(monkeypatch):
    """A transient Holodex outage must degrade to stale-but-usable data, not
    silently delete every normal stream's reminder capability."""
    from api.holodex_client import HolodexAPIError

    old_now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    monkeypatch.setattr(read_api, "get_live_streams", lambda *_a, **_kw: {"streams": [_holodex_stream(videoId="v_good")]})
    written = {}
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: written.update(record))
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: {"value": written["value"]} if written else None)
    first = notification_dispatcher._refresh_and_load_stream_schedule(now=old_now)
    assert "v_good" in first

    def _boom(*a, **kw):
        raise HolodexAPIError("simulated outage")

    monkeypatch.setattr(read_api, "get_live_streams", _boom)
    new_now = old_now + notification_dispatcher._SCHEDULE_REFRESH_INTERVAL * 2
    second = notification_dispatcher._refresh_and_load_stream_schedule(now=new_now)
    assert "v_good" in second


# --- decoupling reminder evaluation cadence from Holodex refresh cadence --


def test_a_fresh_schedule_snapshot_does_not_trigger_a_holodex_request(monkeypatch):
    """Required test 4: a dispatcher invocation must not call Holodex again
    when the persisted snapshot is still within _SCHEDULE_REFRESH_INTERVAL."""
    now = datetime(2026, 1, 1, 0, 0, 30, tzinfo=timezone.utc)  # 30s after refreshedAt below
    refreshed_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        lambda client_id, key: {"value": _schedule_value({"v9": {"creatorId": "aizawa_ema", "scheduledStartMs": 123}}, refreshed_at=refreshed_at)},
    )

    def _boom(*a, **kw):
        raise AssertionError("must not query Holodex while the persisted schedule snapshot is still fresh")

    monkeypatch.setattr(read_api, "get_live_streams", _boom)

    entries = notification_dispatcher._refresh_and_load_stream_schedule(now=now)

    assert entries == {"v9": live_reminder.StreamScheduleEntry(creator_id="aizawa_ema", scheduled_start_ms=123)}


def test_a_stale_schedule_snapshot_triggers_exactly_one_aggregate_refresh(monkeypatch):
    """Required test 5: once stale, exactly one read_api.get_live_streams()
    call happens, aggregating every tracked creator's channel in one request
    (read_api.get_live_streams's own existing contract) -- never a second
    Holodex call within the same refresh."""
    now = datetime(2026, 1, 1, 1, 0, 0, tzinfo=timezone.utc)
    refreshed_at = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)  # 1 hour stale
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        lambda client_id, key: {"value": _schedule_value({}, refreshed_at=refreshed_at)},
    )
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: None)
    calls = []
    monkeypatch.setattr(read_api, "get_live_streams", lambda *a, **kw: (calls.append(1), {"streams": [_holodex_stream()]})[1])

    entries = notification_dispatcher._refresh_and_load_stream_schedule(now=now)

    assert len(calls) == 1
    assert "v2" in entries


def test_multiple_clients_in_one_dispatcher_run_cause_only_one_holodex_refresh(monkeypatch):
    """Required test 6: the schedule refresh happens once per lambda_handler
    invocation (called before the per-client loop even starts), never once
    per client, regardless of how many clients have a stored preference."""
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(now))
    monkeypatch.setattr(notification_events_store, "list_events_for_date", lambda event_date: [])
    monkeypatch.setattr(
        remote_config_store,
        "list_by_key",
        lambda key: [{"clientId": "c1", "value": _preference_value()}, {"clientId": "c2", "value": _preference_value()}],
    )
    calls = []
    monkeypatch.setattr(read_api, "get_live_streams", lambda *a, **kw: (calls.append(1), {"streams": []})[1])
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        lambda client_id, key: None if key == live_reminder.STREAM_SCHEDULE_KEY else {"value": _subscription_value()},
    )
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: None)

    lambda_handler({}, None)

    assert len(calls) == 1


def test_reminder_dedupe_prevents_duplicate_send_for_a_normal_stream_with_no_override(monkeypatch):
    """Item F: the same composite clientId+videoId+kind dedupe already
    proven for the override path applies identically to a normal,
    creator-recurring-only stream."""
    scheduled_start_ms = 1_000_000_000_000
    monkeypatch.setattr(read_api, "get_live_streams", lambda *_a, **_kw: {"streams": [_holodex_stream()]})
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(datetime.fromtimestamp(scheduled_start_ms / 1000, tz=timezone.utc)))
    monkeypatch.setattr(notification_events_store, "list_events_for_date", lambda event_date: [_harmless_discovery_event()])
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": _preference_value()}])
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        _remote_config_stub(subscription=_subscription_value(), creator_reminders={"aizawa_ema": _creator_reminder_value()}),
    )
    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", lambda client_id, video_id: video_id == "v2:reminder:start")

    def _boom(*a, **kw):
        raise AssertionError("should not resend an already-delivered reminder for a normal stream")

    monkeypatch.setattr(push_sender, "send_push_notification", _boom)

    response = lambda_handler({}, None)

    assert response["delivered"] == 0


def _frozen_datetime(fixed_now: datetime) -> type[datetime]:
    """Build a datetime subclass whose now() always returns fixed_now, for monkeypatching module-level `datetime`.

    Subclassing (rather than a bare stand-in object) keeps every other
    datetime classmethod the module under test uses — fromisoformat(),
    combine() via notification_dispatch.py — working unchanged.
    """

    class _Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed_now.astimezone(tz) if tz else fixed_now

    return _Frozen
