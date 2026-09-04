from datetime import datetime, timezone

import pytest

import notification_delivery_log_store
import notification_dispatcher
import notification_events_store
import push_sender
import remote_config_store
from creator_master import Creator
from notification_dispatcher import lambda_handler
from push_sender import PushResult


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


@pytest.fixture(autouse=True)
def stub_vapid(monkeypatch):
    """No real VAPID credentials needed — push_sender itself is stubbed in every test."""
    monkeypatch.setattr(notification_dispatcher, "get_vapid_credentials", lambda: ("pem", {"sub": "mailto:a@b.com"}))


@pytest.fixture(autouse=True)
def stub_creators(monkeypatch):
    monkeypatch.setattr(notification_dispatcher, "load_creators", lambda: [_creator()])


def test_no_recent_events_short_circuits_without_touching_preferences(monkeypatch):
    monkeypatch.setattr(notification_events_store, "list_events_for_date", lambda event_date: [])

    def _boom(key):
        raise AssertionError("should not look up preferences when there are no candidate events")

    monkeypatch.setattr(remote_config_store, "list_by_key", _boom)

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
