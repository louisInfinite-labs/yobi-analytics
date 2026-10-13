"""New-video eligibility is fail-closed, and a new-video switch only ever delivers videos discovered AFTER it was turned on.

Two production defects (Android client, 2026-10-13 22:48 JST) are pinned here:
1. A creator with no entry in `newVideoCreatorOverride` used to default to ON. The client only lists the creators its Settings roster shows
   (97 members), so UNIT B / ACHRORA / FUWAMOCO / hololive Official (group channels) and every graduated / staff channel were notified.
   Now: True -> eligible, False -> not, MISSING -> not.
2. The client's first dispatcher run examined the whole 3-day lookback and pushed every "wanted" video, however old. Now the backend stamps
   `newVideoActivatedAt[creatorId]` whenever a creator's switch goes ON (first enable, global OFF -> ON, creator OFF -> ON), and only a video
   discovered at or after that instant may be pushed; everything older is recorded as suppressed and never replays.

No test here touches AWS: the stores, push sender and clock are all stubbed.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from notifications import notification_dispatcher
from notifications import push_sender
from notifications.notification_dispatch import (
    ClientError,
    is_new_video_after_activation,
    is_new_video_creator_enabled,
    is_new_video_wanted,
    parse_notification_preference,
    stamp_new_video_activation,
    with_legacy_new_video_activation,
)
from notifications.notification_dispatcher import lambda_handler
from notifications.push_sender import PushResult
from stores import notification_events_store
from stores import remote_config_store

from tests.notifications.test_notification_dispatcher import (
    _fake_delivery_log,
    _frozen_datetime,
    _subscription_value,
    # The dispatcher module's autouse fixtures (no real VAPID / Holodex / remote-config access); importing them by name makes pytest
    # apply them to this module too.
    stub_creators,  # noqa: F401
    stub_live_streams,  # noqa: F401
    stub_reminder_items,  # noqa: F401
    stub_vapid,  # noqa: F401
)

JST = timezone(timedelta(hours=9))
CREATORS_JSON = Path(__file__).resolve().parents[2] / "src" / "creators.json"


def _utc(day: int, hour: int, minute: int = 0) -> datetime:
    """A 2026-09-<day> instant in UTC."""
    return datetime(2026, 9, day, hour, minute, tzinfo=timezone.utc)


def _raw(*, enabled: bool = True, on: tuple[str, ...] = (), off: tuple[str, ...] = (), **extra) -> dict:
    """The preference body a client PUTs: an explicit True/False per creator it lists (what buildNotificationPreference sends)."""
    body = {
        "enabled": enabled,
        "notificationLevel": "all",
        "notificationTimeZone": "Asia/Tokyo",
        "deliveryWindows": ["08:00", "18:00"],
        "newVideoCreatorOverride": {**{c: False for c in off}, **{c: True for c in on}},
    }
    body.update(extra)
    return body


def _store(raw: dict, *, previous: dict | None, now: datetime, previous_updated_at: str | None = None) -> dict:
    """What the PUT handler would store: the incoming body with newVideoActivatedAt stamped by the backend."""
    return stamp_new_video_activation(raw, previous_value=previous, previous_updated_at=previous_updated_at, now=now)


def _activated(stored: dict) -> dict[str, str]:
    return stored["newVideoActivatedAt"]


# --- 1. fail-closed creator eligibility --------------------------------------


@pytest.mark.parametrize(
    ("override", "expected"),
    [(True, True), (False, False), (None, False)],
    ids=["true -> eligible", "false -> excluded", "missing -> excluded"],
)
def test_only_an_explicit_true_makes_a_creator_eligible(override, expected):
    overrides = {} if override is None else {"aizawa_ema": override}
    preference = parse_notification_preference(_raw(**{"newVideoCreatorOverride": overrides}))

    assert is_new_video_creator_enabled(preference, "aizawa_ema") is expected
    assert is_new_video_wanted(preference, "aizawa_ema", content_type=None) is expected


@pytest.mark.parametrize(
    "creator_id",
    [
        "someone_nobody_has_heard_of",  # unknown creator
        "unit_b_pre_debut",  # group channel (pre-debut)
        "hololive_official",  # group channel
        "holoan_room",  # staff channel
        "gawr_gura",  # graduated member
        "a_creator_added_to_the_master_next_year",  # a future creator the client's roster does not know yet
    ],
)
def test_a_creator_absent_from_the_map_is_excluded(creator_id):
    """No creator is special-cased or hardcoded: ANY creator the client did not list is off."""
    preference = parse_notification_preference(_raw(on=("aizawa_ema",), off=("shirakami_fubuki",)))

    assert is_new_video_creator_enabled(preference, creator_id) is False


def test_a_preference_with_no_map_at_all_wants_nobody():
    body = _raw()
    del body["newVideoCreatorOverride"]

    assert is_new_video_creator_enabled(parse_notification_preference(body), "aizawa_ema") is False


# --- 2. the activation field -------------------------------------------------


def test_activation_must_be_an_object_of_offset_timestamps():
    ok = parse_notification_preference(_raw(newVideoActivatedAt={"aizawa_ema": "2026-09-10T00:00:00+00:00"}))
    assert ok.new_video_activated_at == {"aizawa_ema": _utc(10, 0)}
    assert parse_notification_preference(_raw()).new_video_activated_at == {}

    for bad in ([], "x", {"aizawa_ema": 5}, {"aizawa_ema": "not a time"}, {"aizawa_ema": "2026-09-10T00:00:00"}, {"": "2026-09-10T00:00:00+00:00"}):
        with pytest.raises(ClientError):
            parse_notification_preference(_raw(newVideoActivatedAt=bad))


def test_a_video_is_after_activation_only_from_the_activation_instant_on():
    preference = parse_notification_preference(_raw(on=("aizawa_ema",), newVideoActivatedAt={"aizawa_ema": _utc(10, 6).isoformat()}))

    assert is_new_video_after_activation(preference, "aizawa_ema", discovered_at=_utc(10, 5, 59)) is False
    assert is_new_video_after_activation(preference, "aizawa_ema", discovered_at=_utc(10, 6)) is True
    assert is_new_video_after_activation(preference, "aizawa_ema", discovered_at=_utc(10, 7)) is True
    # no recorded activation -> fail closed
    assert is_new_video_after_activation(preference, "shirakami_fubuki", discovered_at=_utc(11, 0)) is False


# --- 3. the backend stamps the boundary (cases A-D) --------------------------


def test_a_first_ever_enable_stamps_every_enabled_creator_with_the_server_clock_and_nobody_else():
    stored = _store(_raw(on=("aizawa_ema", "kosuzume_toto"), off=("shirakami_fubuki",)), previous=None, now=_utc(10, 3))

    assert _activated(stored) == {"aizawa_ema": _utc(10, 3).isoformat(), "kosuzume_toto": _utc(10, 3).isoformat()}
    assert stored["newVideoCreatorOverride"] == {"shirakami_fubuki": False, "aizawa_ema": True, "kosuzume_toto": True}  # the rest is stored as sent


def test_a_client_supplied_activation_is_ignored():
    forged = _raw(on=("aizawa_ema",), newVideoActivatedAt={"aizawa_ema": "2020-01-01T00:00:00+00:00", "gawr_gura": "2020-01-01T00:00:00+00:00"})

    stored = _store(forged, previous=None, now=_utc(10, 3))

    assert _activated(stored) == {"aizawa_ema": _utc(10, 3).isoformat()}


def test_an_unrelated_edit_does_not_move_the_boundary():
    first = _store(_raw(on=("aizawa_ema",)), previous=None, now=_utc(10, 3))

    edited = _store(
        _raw(on=("aizawa_ema",), notificationLocale="ja", notificationTimeZone="Asia/Tokyo", newVideoShortCreatorOverride={"kosuzume_toto": True}),
        previous=first,
        now=_utc(12, 3),
    )

    assert _activated(edited) == {"aizawa_ema": _utc(10, 3).isoformat()}


def test_a_creator_switched_on_later_gets_its_own_new_boundary_and_the_others_keep_theirs():
    first = _store(_raw(on=("aizawa_ema",), off=("kosuzume_toto",)), previous=None, now=_utc(10, 3))

    second = _store(_raw(on=("aizawa_ema", "kosuzume_toto")), previous=first, now=_utc(11, 3))

    assert _activated(second) == {"aizawa_ema": _utc(10, 3).isoformat(), "kosuzume_toto": _utc(11, 3).isoformat()}


def test_a_creator_switched_off_and_on_again_restarts_from_the_second_time():
    on = _store(_raw(on=("aizawa_ema",)), previous=None, now=_utc(10, 3))
    off = _store(_raw(off=("aizawa_ema",)), previous=on, now=_utc(11, 3))
    again = _store(_raw(on=("aizawa_ema",)), previous=off, now=_utc(12, 3))

    assert _activated(off) == {}
    assert _activated(again) == {"aizawa_ema": _utc(12, 3).isoformat()}


def test_the_global_switch_going_off_then_on_restarts_every_creator():
    on = _store(_raw(on=("aizawa_ema", "kosuzume_toto")), previous=None, now=_utc(10, 3))
    off = _store(_raw(enabled=False, on=("aizawa_ema", "kosuzume_toto")), previous=on, now=_utc(11, 3))
    again = _store(_raw(on=("aizawa_ema", "kosuzume_toto")), previous=off, now=_utc(12, 3))

    assert _activated(off) == {}  # nothing is "on" while the master switch is off, even though the creator switches are remembered
    assert _activated(again) == {"aizawa_ema": _utc(12, 3).isoformat(), "kosuzume_toto": _utc(12, 3).isoformat()}


def test_a_preference_stored_before_activation_tracking_hands_its_last_write_time_to_creators_that_were_already_on():
    legacy = _raw(on=("aizawa_ema",))  # no newVideoActivatedAt: what production holds today

    edited = _store(_raw(on=("aizawa_ema", "kosuzume_toto")), previous=legacy, now=_utc(12, 3), previous_updated_at="2026-09-11T00:00:00+00:00")

    assert _activated(edited) == {"aizawa_ema": "2026-09-11T00:00:00+00:00", "kosuzume_toto": _utc(12, 3).isoformat()}


def test_an_unreadable_previous_value_counts_as_nothing_was_on():
    stored = _store(_raw(on=("aizawa_ema",)), previous={"enabled": "yes"}, now=_utc(12, 3))

    assert _activated(stored) == {"aizawa_ema": _utc(12, 3).isoformat()}


def test_legacy_fill_bounds_creators_without_an_instant_by_the_last_write_and_leaves_existing_ones_alone():
    pref = parse_notification_preference(
        _raw(on=("aizawa_ema", "kosuzume_toto"), off=("shirakami_fubuki",), newVideoActivatedAt={"kosuzume_toto": _utc(5, 0).isoformat()})
    )

    filled = with_legacy_new_video_activation(pref, stored_at=_utc(11, 0))

    assert filled.new_video_activated_at == {"aizawa_ema": _utc(11, 0), "kosuzume_toto": _utc(5, 0)}
    assert with_legacy_new_video_activation(pref, stored_at=None) is pref  # unknown write time -> stays fail-closed


# --- 4. dispatcher behaviour over real timelines ------------------------------


def _event(video_id: str, creator_id: str, discovered_at: datetime, *, content_type: str | None = None) -> dict:
    local = discovered_at.astimezone(JST)
    item = {
        "eventDate": local.date().isoformat(),
        "videoId": video_id,
        "creatorId": creator_id,
        "title": f"title {video_id}",
        "discoveredAt": local.isoformat(),
    }
    if content_type is not None:
        item["contentType"] = content_type
    return item


NOW = _utc(12, 9, 5)  # 18:05 JST on 09-12: every 08:00 / 18:00 window of 09-10 and 09-11 has passed; 09-10..09-12 are the 3-day lookback


def _run(monkeypatch, *, preference: dict, events: list[dict], updated_at: str | None = None, now: datetime = NOW) -> list[str]:
    """One dispatcher pass at `now`; returns the videoIds pushed. Shares the delivery log `_fake_delivery_log` installed for this test."""
    by_date: dict[str, list[dict]] = {}
    for event in events:
        by_date.setdefault(event["eventDate"], []).append(event)
    record = {"clientId": "c1", "value": preference}
    if updated_at is not None:
        record["updatedAt"] = updated_at
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(now))
    monkeypatch.setattr(notification_events_store, "list_events_for_date", lambda event_date: by_date.get(event_date, []))
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [record])
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: {"value": _subscription_value()})
    sent: list[str] = []
    monkeypatch.setattr(
        push_sender,
        "send_push_notification",
        lambda *a, **kw: (sent.append(kw["data"]["videoId"]), PushResult(sent=True, subscription_expired=False))[1],
    )
    lambda_handler({}, None)
    return sent


def test_an_event_discovered_before_the_first_enable_is_not_delivered_and_one_after_it_is(monkeypatch):
    rows = _fake_delivery_log(monkeypatch)
    stored = _store(_raw(on=("aizawa_ema",)), previous=None, now=_utc(11, 3))
    events = [_event("old", "aizawa_ema", _utc(10, 3)), _event("new", "aizawa_ema", _utc(11, 6))]

    sent = _run(monkeypatch, preference=stored, events=events)

    assert sent == ["new"]
    assert rows[("c1", "old")] == "suppressed"
    assert rows[("c1", "new")] == "delivered"


def test_an_event_discovered_while_notifications_were_off_is_not_replayed_after_they_are_turned_back_on(monkeypatch):
    rows = _fake_delivery_log(monkeypatch)
    first = _store(_raw(on=("aizawa_ema",)), previous=None, now=_utc(9, 0))
    off = _store(_raw(enabled=False, on=("aizawa_ema",)), previous=first, now=_utc(9, 12))
    back_on = _store(_raw(on=("aizawa_ema",)), previous=off, now=_utc(10, 6))
    events = [_event("while-off", "aizawa_ema", _utc(10, 0)), _event("after", "aizawa_ema", _utc(10, 12))]

    sent = _run(monkeypatch, preference=back_on, events=events)

    assert sent == ["after"]
    assert rows[("c1", "while-off")] == "suppressed"


def test_a_creator_turned_on_later_does_not_replay_that_creators_old_events(monkeypatch):
    rows = _fake_delivery_log(monkeypatch)
    first = _store(_raw(on=("aizawa_ema",), off=("kosuzume_toto",)), previous=None, now=_utc(9, 0))
    events = [
        _event("toto-old", "kosuzume_toto", _utc(10, 0)),  # discovered while toto was OFF
        _event("ema-old", "aizawa_ema", _utc(10, 1)),  # ema has been ON since 09-09: this one is wanted
    ]
    # an earlier pass while toto is still OFF records toto's old event as suppressed
    assert _run(monkeypatch, preference=first, events=events, now=_utc(10, 9, 5)) == ["ema-old"]
    assert rows[("c1", "toto-old")] == "suppressed"

    second = _store(_raw(on=("aizawa_ema", "kosuzume_toto")), previous=first, now=_utc(10, 12))
    events += [_event("toto-new", "kosuzume_toto", _utc(10, 14))]
    sent = _run(monkeypatch, preference=second, events=events)

    assert sent == ["toto-new"]  # the event of the OFF period stays settled; the one after the switch flipped is delivered


def test_a_pre_activation_event_is_never_delivered_even_if_its_creator_was_never_seen_off(monkeypatch):
    """No earlier suppression row exists (the observed Android case): the boundary alone must stop the old event."""
    rows = _fake_delivery_log(monkeypatch)
    stored = _store(_raw(on=("kosuzume_toto",)), previous=None, now=_utc(11, 12))

    sent = _run(monkeypatch, preference=stored, events=[_event("toto-old", "kosuzume_toto", _utc(10, 3))])

    assert sent == []
    assert rows == {("c1", "toto-old"): "suppressed"}


def test_a_suppressed_event_never_replays_whatever_the_preference_later_says(monkeypatch):
    rows = _fake_delivery_log(monkeypatch)
    rows[("c1", "settled")] = "suppressed"  # recorded while the creator / switch was off
    stored = _store(_raw(on=("aizawa_ema",)), previous=None, now=_utc(9, 0))  # activation is OLDER than the event: otherwise wanted

    sent = _run(monkeypatch, preference=stored, events=[_event("settled", "aizawa_ema", _utc(10, 3))])

    assert sent == []
    assert rows[("c1", "settled")] == "suppressed"


def test_a_retried_or_duplicated_invocation_is_idempotent(monkeypatch):
    rows = _fake_delivery_log(monkeypatch)
    stored = _store(_raw(on=("aizawa_ema",)), previous=None, now=_utc(11, 3))
    events = [_event("old", "aizawa_ema", _utc(10, 3)), _event("new", "aizawa_ema", _utc(11, 6))]

    first = _run(monkeypatch, preference=stored, events=events)
    second = _run(monkeypatch, preference=stored, events=events, now=NOW + timedelta(minutes=1))
    third = _run(monkeypatch, preference=stored, events=events, now=NOW + timedelta(minutes=2))

    assert first == ["new"]
    assert second == [] and third == []
    assert rows == {("c1", "old"): "suppressed", ("c1", "new"): "delivered"}


def test_an_event_whose_window_has_not_arrived_is_still_held_not_dropped(monkeypatch):
    """Discovered AFTER the activation but before its next 08:00 / 18:00 window: held (no row yet), delivered once the window comes."""
    rows = _fake_delivery_log(monkeypatch)
    stored = _store(_raw(on=("aizawa_ema",)), previous=None, now=_utc(12, 0))
    discovered = _utc(12, 8, 30)  # 17:30 JST: the next window is 18:00 JST

    held = _run(monkeypatch, preference=stored, events=[_event("later", "aizawa_ema", discovered)], now=_utc(12, 8, 45))
    rows_while_held = dict(rows)
    due = _run(monkeypatch, preference=stored, events=[_event("later", "aizawa_ema", discovered)], now=_utc(12, 9, 5))

    assert held == []
    assert rows_while_held == {}  # held, not recorded: nothing is settled before its window
    assert due == ["later"]


def test_a_preference_stored_before_activation_tracking_is_bounded_by_its_last_write_time(monkeypatch):
    rows = _fake_delivery_log(monkeypatch)
    legacy = _raw(on=("aizawa_ema",))  # newVideoCreatorOverride True, no newVideoActivatedAt
    events = [_event("before-write", "aizawa_ema", _utc(10, 3)), _event("after-write", "aizawa_ema", _utc(11, 6))]

    sent = _run(monkeypatch, preference=legacy, events=events, updated_at=_utc(11, 3).isoformat())

    assert sent == ["after-write"]
    assert rows[("c1", "before-write")] == "suppressed"


def test_a_legacy_preference_with_no_usable_write_time_fails_closed(monkeypatch):
    rows = _fake_delivery_log(monkeypatch)

    sent = _run(monkeypatch, preference=_raw(on=("aizawa_ema",)), events=[_event("v", "aizawa_ema", _utc(11, 6))])

    assert sent == []
    assert rows == {("c1", "v"): "suppressed"}


def test_shorts_keep_their_own_rules_and_are_not_held_to_the_ordinary_activation(monkeypatch):
    """Out of scope for this fix: a Short is governed by the Short card only (default OFF), exactly as before."""
    rows = _fake_delivery_log(monkeypatch)
    short_on = _raw(on=("aizawa_ema",), newVideoShortCreatorOverride={"aizawa_ema": True})
    stored = _store(short_on, previous=None, now=_utc(11, 12))
    events = [_event("a-short", "aizawa_ema", _utc(10, 3), content_type="short")]  # discovered BEFORE the ordinary activation

    assert _run(monkeypatch, preference=stored, events=events) == ["a-short"]
    assert rows[("c1", "a-short")] == "delivered"


# --- 5. the observed production failure, replayed -----------------------------


def _roster_and_non_roster() -> tuple[list[str], list[str]]:
    """Creators the Settings roster lists (current, individual members) and those it deliberately does not (groups, staff, graduated)."""
    raw = json.loads(CREATORS_JSON.read_text(encoding="utf-8"))
    creators = raw["creators"] if isinstance(raw, dict) else raw
    roster = [c["creatorId"] for c in creators if c.get("channelType") == "member" and c.get("lifecycleStage") != "graduated"]
    non_roster = [c["creatorId"] for c in creators if c["creatorId"] not in set(roster)]
    return roster, non_roster


@pytest.mark.parametrize("legacy_shape", [False, True], ids=["stamped by the new backend", "stored by the old backend (no activation field)"])
def test_the_observed_android_state_no_longer_pushes_creators_the_client_never_selected(monkeypatch, legacy_shape):
    """The Android client of 2026-10-13: a 97-member map (all False, one True) + the creators the roster omits, with the old events of EVERY
    creator inside the 3-day lookback. Before the fix UNIT B / ACHRORA / FUWAMOCO / hololive Official passed (absent -> ON) and were
    delivered, 46-58 hours old. Now none of them may be; an explicitly selected current creator's genuinely NEW video still is."""
    rows = _fake_delivery_log(monkeypatch)
    roster, non_roster = _roster_and_non_roster()
    for must_be_absent in ("unit_b_pre_debut", "achrora", "fuwamoco", "hololive_official"):
        assert must_be_absent in non_roster  # the failing creators really are outside the roster the client writes

    selected = "kosuzume_toto"
    body = _raw(on=(selected,), off=tuple(c for c in roster if c != selected))
    enabled_at = _utc(11, 12)
    if legacy_shape:
        stored, updated_at = body, enabled_at.isoformat()  # what production holds today: no newVideoActivatedAt, a record updatedAt
    else:
        stored, updated_at = _store(body, previous=None, now=enabled_at), None

    old_events = [_event(f"old-{creator}", creator, _utc(10, 3)) for creator in roster + non_roster]  # discovered before the client enabled
    new_events = [_event(f"new-{creator}", creator, _utc(11, 14)) for creator in non_roster + [selected]]  # discovered after
    sent = _run(monkeypatch, preference=stored, events=old_events + new_events, updated_at=updated_at)

    assert sent == [f"new-{selected}"]
    assert not any(video_id.endswith(("unit_b_pre_debut", "achrora", "fuwamoco", "hololive_official")) for video_id in sent)
    assert all(status == "suppressed" for (_client, video_id), status in rows.items() if video_id != f"new-{selected}")
