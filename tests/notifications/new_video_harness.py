"""Shared scaffolding for tests of the 30-minute new-video slot dispatcher (notifications/new_video_dispatcher.py).

`run_slot_pass` stands in for everything outside the dispatcher -- the events table, the slot-recipient index, the stored
preference/subscription, and the push sender -- so a test states only the scenario. The index is modelled the way the preference
write path really fills it: a client appears under the (own IANA zone, local slot) keys of its preference only while it is enabled.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from notifications import new_video_dispatcher, notification_dispatch, push_sender
from notifications.push_sender import PushResult
from stores import notification_delivery_log_store, notification_events_store, notification_slot_store, remote_config_store
from tracking.creator_master import Creator

DEFAULT_ACTIVE_SINCE = "2026-01-01T00:00:00+00:00"

# 18:05 JST: the 18:00 JST tick; the event below (discovered 09-02 18:00 JST) had its next window (09-03 08:00 JST) pass already.
DAY1_EVENING = datetime(2026, 9, 3, 9, 5, tzinfo=timezone.utc)
# A day later; the event is still inside the 3-day lookback.
DAY2_EVENING = datetime(2026, 9, 4, 9, 5, tzinfo=timezone.utc)


def default_creator(**overrides) -> Creator:
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


def event_item(**overrides) -> dict:
    fields = {
        "eventDate": "2026-09-03",
        "videoId": "v1",
        "creatorId": "aizawa_ema",
        "title": "New Video",
        "discoveredAt": "2026-09-03T18:00:00+09:00",
    }
    fields.update(overrides)
    return fields


def due_event(**overrides) -> dict:
    """An event discovered 09-02 18:00 JST: by DAY1_EVENING its next 08:00/18:00 window has passed."""
    fields = {"eventDate": "2026-09-02", "discoveredAt": "2026-09-02T18:00:00+09:00"}
    fields.update(overrides)
    return event_item(**fields)


# When the default client below switched aizawa_ema's new-video notification ON: before every event these tests discover.
NEW_VIDEO_ACTIVATED_AT = "2026-01-01T00:00:00+00:00"


def preference_value(**overrides) -> dict:
    """A stored preference. The default client has ONE creator switched on for new videos -- aizawa_ema, explicitly (a creator with no
    entry is OFF) and since long before any event these tests discover (an event is only pushed if discovered after the activation)."""
    fields = {
        "enabled": True,
        "notificationLevel": "all",
        "temporaryMute": None,
        "creatorOverride": {},
        "notificationTimeZone": "Asia/Tokyo",
        "deliveryWindows": ["08:00", "18:00"],
        "quietHours": None,
        "newVideoCreatorOverride": {"aizawa_ema": True},
        "newVideoActivatedAt": {"aizawa_ema": NEW_VIDEO_ACTIVATED_AT},
    }
    fields.update(overrides)
    return fields


def subscription_value() -> dict:
    return {
        "endpoint": "https://fcm.googleapis.com/fcm/send/abc123",
        "keys": {"p256dh": "p256dh-key", "auth": "auth-key"},
    }


def fake_delivery_log(monkeypatch) -> dict:
    """Stateful in-memory stand-in for notification_delivery_log_store: {(client, video): status}."""
    rows: dict = {}

    def mark_suppressed(client_id, video_id, at):
        if (client_id, video_id) in rows:
            return False
        rows[(client_id, video_id)] = "suppressed"
        return True

    def mark_delivered(client_id, video_id, at):
        if (client_id, video_id) in rows:
            return False
        rows[(client_id, video_id)] = "claimed"
        return True

    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", lambda client_id, video_id: (client_id, video_id) in rows)
    monkeypatch.setattr(notification_delivery_log_store, "mark_suppressed", mark_suppressed)
    monkeypatch.setattr(notification_delivery_log_store, "mark_delivered", mark_delivered)
    monkeypatch.setattr(
        notification_delivery_log_store, "confirm_delivered", lambda client_id, video_id, at: rows.__setitem__((client_id, video_id), "delivered")
    )
    return rows


def _indexed_slots(preference: dict) -> tuple[str, set[int]] | None:
    """The (zone, local slots) the preference write path would index this client under, or None when it indexes nothing."""
    try:
        parsed = notification_dispatch.parse_notification_preference(preference)
    except notification_dispatch.ClientError:
        return None
    if not parsed.enabled:
        return None
    return parsed.time_zone, set(parsed.delivery_slots)


def install_world(
    monkeypatch,
    *,
    events: list[dict],
    preferences: dict[str, dict],
    with_subscription: bool = True,
    active_since: str = DEFAULT_ACTIVE_SINCE,
    index_clients: list[str] | None = None,
    index_override: dict[tuple[str, int], list[str]] | None = None,
    stub_push: bool = True,
) -> list:
    """Install the stores for one pass and return the list push payloads are appended to.

    `preferences` maps clientId -> stored preference value. The index is derived from them unless `index_override`
    ({(zone, local slot): [clientIds]}) pins it explicitly (used to model a stale index entry). `stub_push=False` leaves
    push_sender.send_push_notification alone so a test can capture the real payload at push_sender.webpush instead.
    """
    monkeypatch.setattr(
        notification_events_store,
        "list_events_for_date",
        lambda event_date: [event for event in events if event["eventDate"] == event_date],
    )

    def _get(client_id: str, key: str):
        if key == "notificationPreference":
            return {"value": preferences[client_id]} if client_id in preferences else None
        if key == "pushSubscription":
            return {"value": subscription_value()} if with_subscription else None
        return None

    monkeypatch.setattr(remote_config_store, "get_remote_config", _get)

    if index_override is not None:
        index = index_override
    else:
        index = {}
        for client_id in index_clients if index_clients is not None else list(preferences):
            indexed = _indexed_slots(preferences[client_id])
            if indexed is None:
                continue
            zone, slots = indexed
            for slot in slots:
                index.setdefault((zone, slot), []).append(client_id)

    monkeypatch.setattr(notification_slot_store, "list_zones", lambda: sorted({zone for zone, _ in index}))
    monkeypatch.setattr(
        notification_slot_store,
        "list_recipients",
        lambda zone, slot: [notification_slot_store.SlotRecipient(c, active_since) for c in sorted(index.get((zone, slot), []))],
    )

    sent: list = []
    if stub_push:

        def _send(subscription, *, title, body, data, vapid_private_key, vapid_claims):
            sent.append(data)
            return PushResult(sent=True, subscription_expired=False)

        monkeypatch.setattr(push_sender, "send_push_notification", _send)
    return sent


def run_slot_pass(
    monkeypatch,
    *,
    now: datetime,
    preference: dict,
    event: dict | None = None,
    events: list[dict] | None = None,
    with_subscription: bool = True,
    active_since: str = DEFAULT_ACTIVE_SINCE,
    clients: tuple[str, ...] = ("c1",),
    event_payload: dict[str, Any] | None = None,
) -> list:
    """One slot-dispatcher run at `now` for clients that all hold `preference`; returns the push payloads sent."""
    pass_events = events if events is not None else [event or due_event()]
    sent = install_world(
        monkeypatch,
        events=pass_events,
        preferences={client_id: preference for client_id in clients},
        with_subscription=with_subscription,
        active_since=active_since,
    )
    new_video_dispatcher.run(event_payload or {}, None, now=now)
    return sent
