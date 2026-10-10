"""Short as a per-member NEW-VIDEO notification card (preference field `newVideoShortCreatorOverride`).

Short is a content FORMAT, not a topic, so the Settings "Short" card is stored in its own field instead of as a topic id:
- `newVideoShortCreatorOverride` ({creatorId: bool}): the members of the Short card. A creator absent from it is OFF, so no
  Short card / a Short card without members / a preference stored before this field existed all mean Short OFF;
- a Short event is delivered only for a creator whose entry is True; the topic and the creator's ordinary 新片 switch play no part;
- an ordinary video never reads the map: it follows the creator's ordinary 新片 switch exactly as before.
Both sit BELOW the global master switch and ABOVE mute / quiet hours' own (temporary) suppression; an event skipped by the
filter is recorded as suppressed and never replayed when the creator is enabled later.
"""

from __future__ import annotations

import pytest

from notifications.notification_dispatch import ClientError, is_new_video_wanted, parse_notification_preference

from tests.notifications.test_notification_dispatcher import (
    _DAY1_EVENING,
    _DAY2_EVENING,
    _event_item,
    _fake_delivery_log,
    _preference_value,
    _run_new_video_pass,
    # The dispatcher module's autouse fixtures (no real VAPID / Holodex / remote-config access); importing them
    # by name makes pytest apply them to this module too.
    stub_creators,  # noqa: F401
    stub_live_streams,  # noqa: F401
    stub_reminder_items,  # noqa: F401
    stub_vapid,  # noqa: F401
)


def _event(**overrides) -> dict:
    """One stored new-video event from the previous evening (its next delivery window has passed at _DAY1_EVENING)."""
    return _event_item(eventDate="2026-09-02", discoveredAt="2026-09-02T18:00:00+09:00", **overrides)


SHORT_EVENT = {"contentType": "short"}  # creator aizawa_ema (the _event_item default)


def _raw(**overrides) -> dict:
    fields = {"enabled": True, "notificationLevel": "all", "notificationTimeZone": "Asia/Tokyo", "deliveryWindows": ["08:00", "18:00"]}
    fields.update(overrides)
    return fields


# --- parsing / defaults ------------------------------------------------------


def test_a_preference_stored_before_the_field_existed_has_no_short_creators():
    assert parse_notification_preference(_raw()).new_video_short_creator_overrides == {}


def test_the_short_creator_map_is_parsed():
    pref = parse_notification_preference(_raw(newVideoShortCreatorOverride={"aizawa_ema": True, "shirakami_fubuki": False}))

    assert pref.new_video_short_creator_overrides == {"aizawa_ema": True, "shirakami_fubuki": False}


@pytest.mark.parametrize("bad", [[], "aizawa_ema", True, {"aizawa_ema": "yes"}, {"": True}, {"aizawa_ema": 1}])
def test_a_malformed_short_creator_map_is_a_client_error(bad):
    with pytest.raises(ClientError, match="newVideoShortCreatorOverride"):
        parse_notification_preference(_raw(newVideoShortCreatorOverride=bad))


def test_short_is_not_stored_as_a_topic():
    pref = parse_notification_preference(_raw(newVideoShortCreatorOverride={"aizawa_ema": True}))

    assert not hasattr(pref, "new_video_topic_overrides")


# --- the decision itself -----------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "content_type", "expected"),
    [
        ({}, "short", False),  # no Short card: OFF by default
        ({"newVideoShortCreatorOverride": {}}, "short", False),  # Short card without members
        ({"newVideoShortCreatorOverride": {"aizawa_ema": True}}, "short", True),
        ({"newVideoShortCreatorOverride": {"aizawa_ema": False}}, "short", False),
        ({"newVideoShortCreatorOverride": {"shirakami_fubuki": True}}, "short", False),  # only the members
        # a Short ignores the ordinary 新片 switch, in both directions
        ({"newVideoShortCreatorOverride": {"aizawa_ema": True}, "newVideoCreatorOverride": {"aizawa_ema": False}}, "short", True),
        ({"newVideoShortCreatorOverride": {}, "newVideoCreatorOverride": {"aizawa_ema": True}}, "short", False),
        # an ordinary video ignores the Short map
        ({}, None, True),
        ({}, "upload", True),
        ({"newVideoShortCreatorOverride": {"aizawa_ema": True}, "newVideoCreatorOverride": {"aizawa_ema": False}}, "upload", False),
        ({"newVideoShortCreatorOverride": {"aizawa_ema": False}}, "upload", True),
    ],
)
def test_wanted_decision(raw, content_type, expected):
    preference = parse_notification_preference(_raw(**raw))

    assert is_new_video_wanted(preference, "aizawa_ema", content_type=content_type) is expected


# --- dispatcher delivery -----------------------------------------------------


def test_a_short_event_is_not_delivered_when_no_short_card_exists(monkeypatch):
    rows = _fake_delivery_log(monkeypatch)

    sent = _run_new_video_pass(monkeypatch, now=_DAY1_EVENING, preference=_preference_value(), event=_event(**SHORT_EVENT))

    assert sent == []
    assert rows == {("c1", "v1"): "suppressed"}


def test_a_short_event_is_delivered_for_a_member_of_the_short_card(monkeypatch):
    _fake_delivery_log(monkeypatch)
    preference = _preference_value(newVideoShortCreatorOverride={"aizawa_ema": True})

    assert _run_new_video_pass(monkeypatch, now=_DAY1_EVENING, preference=preference, event=_event(**SHORT_EVENT)) == [{"videoId": "v1"}]


def test_members_a_and_c_get_their_shorts_but_b_does_not(monkeypatch):
    preference = _preference_value(newVideoShortCreatorOverride={"aizawa_ema": True, "shirakami_fubuki": False, "hakos_baelz": True})

    for creator_id, expected in (("aizawa_ema", [{"videoId": "v1"}]), ("shirakami_fubuki", []), ("hakos_baelz", [{"videoId": "v1"}])):
        _fake_delivery_log(monkeypatch)
        sent = _run_new_video_pass(monkeypatch, now=_DAY1_EVENING, preference=preference, event=_event(creatorId=creator_id, **SHORT_EVENT))
        assert sent == expected, creator_id


def test_an_mv_short_follows_the_short_card_not_the_mv_topic(monkeypatch):
    # Even an event that carries a topic is judged by its format only: this client never enabled this creator's Shorts.
    _fake_delivery_log(monkeypatch)

    sent = _run_new_video_pass(
        monkeypatch, now=_DAY1_EVENING, preference=_preference_value(), event=_event(topic="mv", **SHORT_EVENT)
    )

    assert sent == []


def test_an_ordinary_video_is_unaffected_by_the_short_card(monkeypatch):
    _fake_delivery_log(monkeypatch)
    preference = _preference_value(newVideoShortCreatorOverride={"aizawa_ema": True})

    assert _run_new_video_pass(monkeypatch, now=_DAY1_EVENING, preference=preference, event=_event()) == [{"videoId": "v1"}]


def test_a_legacy_event_without_a_content_type_is_an_ordinary_video(monkeypatch):
    _fake_delivery_log(monkeypatch)

    assert _run_new_video_pass(monkeypatch, now=_DAY1_EVENING, preference=_preference_value(), event=_event()) == [{"videoId": "v1"}]


def test_the_global_master_switch_beats_the_short_card(monkeypatch):
    rows = _fake_delivery_log(monkeypatch)
    preference = _preference_value(enabled=False, newVideoShortCreatorOverride={"aizawa_ema": True})

    sent = _run_new_video_pass(monkeypatch, now=_DAY1_EVENING, preference=preference, event=_event(**SHORT_EVENT))

    assert sent == []
    assert rows == {("c1", "v1"): "suppressed"}


def test_the_general_creator_override_still_beats_the_short_card(monkeypatch):
    _fake_delivery_log(monkeypatch)
    preference = _preference_value(creatorOverride={"aizawa_ema": False}, newVideoShortCreatorOverride={"aizawa_ema": True})

    assert _run_new_video_pass(monkeypatch, now=_DAY1_EVENING, preference=preference, event=_event(**SHORT_EVENT)) == []


def test_mute_still_suppresses_a_short_without_recording_it(monkeypatch):
    rows = _fake_delivery_log(monkeypatch)
    preference = _preference_value(newVideoShortCreatorOverride={"aizawa_ema": True}, temporaryMute="2026-09-03T10:00:00+00:00")

    sent = _run_new_video_pass(monkeypatch, now=_DAY1_EVENING, preference=preference, event=_event(**SHORT_EVENT))

    assert sent == []
    assert rows == {}  # mute is temporary: delivered once it ends


def test_quiet_hours_still_suppress_a_short_without_recording_it(monkeypatch):
    rows = _fake_delivery_log(monkeypatch)
    preference = _preference_value(newVideoShortCreatorOverride={"aizawa_ema": True}, quietHours=["17:00", "20:00"])  # 18:05 JST

    sent = _run_new_video_pass(monkeypatch, now=_DAY1_EVENING, preference=preference, event=_event(**SHORT_EVENT))

    assert sent == []
    assert rows == {}


def test_a_short_skipped_while_the_creator_was_off_is_not_replayed_when_the_creator_is_enabled(monkeypatch):
    rows = _fake_delivery_log(monkeypatch)

    off = _run_new_video_pass(monkeypatch, now=_DAY1_EVENING, preference=_preference_value(), event=_event(**SHORT_EVENT))
    assert off == []
    assert rows == {("c1", "v1"): "suppressed"}

    on = _run_new_video_pass(
        monkeypatch,
        now=_DAY2_EVENING,
        preference=_preference_value(newVideoShortCreatorOverride={"aizawa_ema": True}),
        event=_event(**SHORT_EVENT),
    )
    assert on == []
