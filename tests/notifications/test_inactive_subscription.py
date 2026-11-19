"""A push subscription the push service confirmed gone (404 / 410) is marked INACTIVE and never tried again; re-subscribing recovers it.

Production evidence (2026-11-16 audit): 2 of the 7 stored subscriptions answered 404/410 at every reminder (98 events in 7 days), the dispatchers printing
"leaving cleanup to a future pass" while no such pass existed -- and both users still had reminders saved.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from api import remote_config_api
from notifications import notification_dispatcher, subscription_state
from notifications.push_sender import PushResult
from stores import remote_config_store
from stores.remote_config_store import (
    get_remote_config,
    is_inactive,
    list_remote_config,
    mark_push_subscription_inactive,
    put_remote_config,
)
from tests.notifications.op_counting_harness import CountingHarness
from tests.notifications.test_scheduled_start_notifications import AT_START, SNAPSHOT_AT, START, _stream
from tests.stores.test_remote_config_store import remote_config_table  # noqa: F401 -- the production-shaped table fixture

RUN = timedelta(seconds=4.7)
GONE_410 = PushResult(sent=False, subscription_expired=True, error="HTTP 410", status_code=410)
GONE_404 = PushResult(sent=False, subscription_expired=True, error="HTTP 404", status_code=404)
SUBSCRIPTION = {"endpoint": "https://web.push.apple.com/abc", "keys": {"p256dh": "k", "auth": "a"}}
KEY = "pushSubscription"


# ============ the store (real conditional UpdateItem on a moto table) ============


def _store(client_id="c1", subscription=SUBSCRIPTION):
    """A stored subscription, written exactly like the API's PUT does."""
    put_remote_config(remote_config_api.write_remote_config({"clientId": client_id, "key": KEY, "value": subscription}))


def test_marking_inactive_keeps_the_subscription_and_adds_a_visible_marker(remote_config_table):  # noqa: F811
    """Nothing is deleted: the value stays (so the marker can be cleared by hand), and the record now says it is inactive and why."""
    _store()

    assert mark_push_subscription_inactive("c1", SUBSCRIPTION["endpoint"], at="2026-11-16T01:00:00+00:00", reason="push_service_http_410") is True

    record = get_remote_config("c1", KEY)
    assert record["value"] == SUBSCRIPTION and is_inactive(record)
    assert record["inactiveAt"] == "2026-11-16T01:00:00+00:00" and record["inactiveReason"] == "push_service_http_410"


def test_only_the_subscription_the_push_service_rejected_is_marked(remote_config_table):  # noqa: F811
    """The client re-subscribed while the failing push was in flight: the NEW subscription must stay active."""
    _store()

    assert mark_push_subscription_inactive("c1", "https://web.push.apple.com/SOMETHING-ELSE", at="t", reason="r") is False
    assert not is_inactive(get_remote_config("c1", KEY))


def test_marking_never_creates_a_missing_record_and_is_idempotent(remote_config_table):  # noqa: F811
    """No subscription = nothing to mark (the conditional update must not create a half-record); a second mark does not overwrite the first."""
    assert mark_push_subscription_inactive("ghost", SUBSCRIPTION["endpoint"], at="t", reason="r") is False
    assert get_remote_config("ghost", KEY) is None

    _store()
    assert mark_push_subscription_inactive("c1", SUBSCRIPTION["endpoint"], at="first", reason="r") is True
    assert mark_push_subscription_inactive("c1", SUBSCRIPTION["endpoint"], at="second", reason="r") is False
    assert get_remote_config("c1", KEY)["inactiveAt"] == "first"


def test_subscribing_again_through_the_app_recovers_the_user(remote_config_table):  # noqa: F811
    """The PWA's enable flow PUTs the new subscription, which replaces the WHOLE item -- so the marker is gone and the client is active again."""
    _store()
    mark_push_subscription_inactive("c1", SUBSCRIPTION["endpoint"], at="t", reason="r")
    assert is_inactive(get_remote_config("c1", KEY))

    fresh = {"endpoint": "https://web.push.apple.com/NEW", "keys": {"p256dh": "k2", "auth": "a2"}}
    put_remote_config(remote_config_api.write_remote_config({"clientId": "c1", "key": KEY, "value": fresh}))

    record = get_remote_config("c1", KEY)
    assert record["value"] == fresh and not is_inactive(record) and "inactiveAt" not in record


def test_a_subscription_replaced_between_the_read_and_the_write_is_never_marked(remote_config_table, monkeypatch):  # noqa: F811
    """The race the conditional put exists for: the client re-subscribes (same endpoint, new save) after the marker's GetItem and before its PutItem."""
    _store()
    original = remote_config_store._resource

    class Racing:
        """A resource whose table re-subscribes the client right after the marker's GetItem."""

        def __init__(self):
            """Wrap the real resource."""
            self._real = original()

        def Table(self, name):
            """The real table, with get_item followed by the client's own re-subscribe."""
            real_table = self._real.Table(name)

            class T:
                """A table facade."""

                def get_item(self, **kw):
                    """Read, then let the client re-subscribe (same endpoint, later updatedAt) before the caller writes."""
                    out = real_table.get_item(**kw)
                    real_table.put_item(Item={"clientId": "c1", "configKey": KEY, "value": SUBSCRIPTION, "updatedAt": "2099-01-01T00:00:00+00:00"})
                    return out

                def __getattr__(self, attr):
                    """Everything else is the real table."""
                    return getattr(real_table, attr)

            return T()

    monkeypatch.setattr(remote_config_store, "_resource", Racing)

    assert mark_push_subscription_inactive("c1", SUBSCRIPTION["endpoint"], at="t", reason="r") is False
    monkeypatch.setattr(remote_config_store, "_resource", original)
    assert not is_inactive(get_remote_config("c1", KEY)) and get_remote_config("c1", KEY)["updatedAt"] == "2099-01-01T00:00:00+00:00"


def test_marking_uses_only_operations_the_role_already_has(remote_config_table, monkeypatch):  # noqa: F811
    """No UpdateItem on this table: GetItem + PutItem only (the lambda role's policy is managed outside Terraform and cannot be read to confirm a new action)."""
    _store()
    original = remote_config_store._resource
    used = []

    class Spy:
        """Record which DynamoDB operations the marker issues."""

        def __init__(self):
            """Wrap the real resource."""
            self._real = original()

        def Table(self, name):
            """A table whose calls are recorded."""
            real_table = self._real.Table(name)

            class T:
                """A recording facade."""

                def __getattr__(self, attr):
                    """Record the operation name, then delegate."""
                    if attr.endswith("_item") or attr in ("query", "scan"):
                        used.append(attr)
                    return getattr(real_table, attr)

            return T()

    monkeypatch.setattr(remote_config_store, "_resource", Spy)
    assert mark_push_subscription_inactive("c1", SUBSCRIPTION["endpoint"], at="t", reason="r") is True
    assert used == ["get_item", "put_item"]


def test_other_records_of_the_client_are_untouched_by_the_marker(remote_config_table):  # noqa: F811
    """Preferences and reminder settings stay exactly as saved: only the one subscription item gets the two attributes."""
    _store()
    put_remote_config(remote_config_api.write_remote_config({"clientId": "c1", "key": "notificationPreference", "value": {"enabled": True}}))

    mark_push_subscription_inactive("c1", SUBSCRIPTION["endpoint"], at="t", reason="r")

    by_key = {record["key"]: record for record in list_remote_config("c1")}
    assert "inactiveAt" not in by_key["notificationPreference"] and by_key["notificationPreference"]["value"] == {"enabled": True}


# ============ the helper ============


@pytest.mark.parametrize("status, reason", [(410, "push_service_http_410"), (404, "push_service_http_404"), (None, "push_service_gone")])
def test_the_recorded_reason_names_the_status(status, reason):
    """Why it was marked, for whoever looks at the record later."""
    assert subscription_state.reason_for(status) == reason


def test_a_failure_to_write_the_marker_never_breaks_the_send_path(monkeypatch):
    """Bookkeeping only: the helper swallows (and logs) any store error."""
    def boom(*_a, **_k):
        """The table is unreachable."""
        raise remote_config_store.RemoteConfigStoreError("down")

    monkeypatch.setattr(remote_config_store, "mark_push_subscription_inactive", boom)

    assert subscription_state.mark_inactive_after_expiry("c1", SUBSCRIPTION, 410, START) is False
    assert subscription_state.mark_inactive_after_expiry("c1", {"no": "endpoint"}, 410, START) is False


# ============ the reminder dispatcher ============


class _World(CountingHarness):
    """The counting harness plus the marker: the fake store honours the same condition as the real conditional update."""

    def __init__(self, monkeypatch):
        """Wire the base world and the marker."""
        super().__init__(monkeypatch)
        self.inactive: dict[str, tuple[str, str]] = {}
        monkeypatch.setattr(remote_config_store, "mark_push_subscription_inactive", self._mark)

    def _mark(self, client_id, endpoint, *, at, reason):
        """The conditional update: only the same endpoint, only once."""
        value = self.config.get((client_id, notification_dispatcher._PUSH_SUBSCRIPTION_KEY))
        if value is None or value.get("endpoint") != endpoint or client_id in self.inactive:
            return False
        self.inactive[client_id] = (at, reason)
        return True

    def _get_config(self, client_id, key):
        """The base record plus the marker for a subscription."""
        record = super()._get_config(client_id, key)
        if record is not None and key == notification_dispatcher._PUSH_SUBSCRIPTION_KEY and client_id in self.inactive:
            record = {**record, "inactiveAt": self.inactive[client_id][0], "inactiveReason": self.inactive[client_id][1]}
        return record

    def resubscribe(self, client_id, endpoint):
        """What the app's enable flow does: a whole new item, so no marker."""
        self.config[(client_id, notification_dispatcher._PUSH_SUBSCRIPTION_KEY)] = {**self.config[(client_id, notification_dispatcher._PUSH_SUBSCRIPTION_KEY)], "endpoint": endpoint}
        self.inactive.pop(client_id, None)


@pytest.fixture
def world(monkeypatch):
    """One subscriber (c1) who wants the start of two streams in a row (21:15 and 22:15 JST)."""
    monkeypatch.setattr(notification_dispatcher, "_MAX_RECOVERY_LOOKBACK", timedelta(minutes=10))
    monkeypatch.setattr(notification_dispatcher, "_last_served_ms", None)
    harness = _World(monkeypatch)
    harness.add_client("c1", creator_reminders={"aizawa_ema": AT_START})
    harness.refresh_snapshot([_stream("v1"), _stream("v2", start=START + timedelta(hours=1))], SNAPSHOT_AT)
    return harness


@pytest.mark.parametrize("result, status", [(GONE_410, 410), (GONE_404, 404)])
def test_a_confirmed_dead_subscription_is_marked_inactive_and_not_tried_again(world, result, status):
    """The first 404/410 marks it; the next reminder (an hour later) does not even attempt a push."""
    world.push_results = [result]

    world.run(START + RUN)
    assert world.inactive["c1"][1] == f"push_service_http_{status}" and len(world.pushes) == 1

    world.run(START + timedelta(hours=1) + RUN)  # the second stream's start

    assert len(world.pushes) == 1  # no second attempt against the dead subscription


@pytest.mark.parametrize(
    "result",
    [
        PushResult(sent=False, subscription_expired=False, error="HTTP 503", retryable=True, status_code=503),
        PushResult(sent=False, subscription_expired=False, error="HTTP 400", retryable=False, status_code=400),
        PushResult(sent=False, subscription_expired=False, error="HTTP 403", retryable=False, status_code=403),
    ],
)
def test_other_failures_never_mark_a_subscription_inactive(world, result):
    """Only a confirmed 404/410 is evidence the subscription is gone; a 5xx, a 4xx rejection or a VAPID problem is not."""
    world.push_results = [result, result]

    world.run(START + RUN)

    assert world.inactive == {}


def test_a_subscription_that_was_replaced_while_the_push_was_in_flight_stays_active(world, monkeypatch):
    """The failing push belonged to the OLD endpoint; the client has already stored a new one."""
    def send(subscription, **_kwargs):
        """The push fails with 410 -- and the client re-subscribes at that very moment."""
        world.config[("c1", notification_dispatcher._PUSH_SUBSCRIPTION_KEY)] = {**subscription, "endpoint": "https://push.example/NEW"}
        return GONE_410

    monkeypatch.setattr(notification_dispatcher.push_sender, "send_push_notification", lambda subscription, **kw: send(subscription, **kw))

    world.run(START + RUN)

    assert world.inactive == {}


def test_after_subscribing_again_reminders_flow_again(world):
    """Recovery end to end: dead -> marked -> no attempts -> the user turns notifications off and on (new endpoint) -> the next reminder is delivered."""
    world.push_results = [GONE_410]
    world.run(START + RUN)
    assert "c1" in world.inactive

    world.resubscribe("c1", "https://push.example/c1-renewed")
    world.run(START + timedelta(hours=1) + RUN)

    assert [p["endpoint"] for p in world.pushes if p["sent"]] == ["https://push.example/c1-renewed"]


def test_an_inactive_subscription_costs_no_further_reads_than_a_missing_one(world):
    """The skip happens right after the subscription read: no delivery-log claim, no push."""
    world.push_results = [GONE_410]
    world.run(START + RUN)
    world.take_ops()

    world.run(START + timedelta(hours=1) + RUN)

    assert [op for op in world.take_ops() if op[0] == "delivery_write"] == []


# ============ the other two send paths ============


def test_the_new_video_path_marks_and_skips(monkeypatch):
    """Slot delivery: a 410 marks the stored subscription; an inactive one is not sent to."""
    from notifications import new_video_dispatcher
    from stores import notification_delivery_log_store
    from tests.notifications.new_video_harness import DAY1_EVENING, due_event, fake_delivery_log, install_world, preference_value

    fake_delivery_log(monkeypatch)
    monkeypatch.setattr(notification_delivery_log_store, "release_claim", lambda client_id, video_id: None)
    marked = []
    monkeypatch.setattr(remote_config_store, "mark_push_subscription_inactive", lambda client_id, endpoint, *, at, reason: marked.append((client_id, reason)) or True)
    install_world(monkeypatch, events=[due_event()], preferences={"c1": preference_value()})
    monkeypatch.setattr(new_video_dispatcher.push_sender, "send_push_notification", lambda *a, **kw: GONE_410)

    new_video_dispatcher.run({}, None, now=DAY1_EVENING)

    assert marked == [("c1", "push_service_http_410")]

    sent = []
    fake_delivery_log(monkeypatch)
    install_world(monkeypatch, events=[due_event()], preferences={"c1": preference_value()})
    real_get = remote_config_store.get_remote_config
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        lambda client_id, key: ({**real_get(client_id, key), "inactiveAt": "t"} if key == "pushSubscription" and real_get(client_id, key) else real_get(client_id, key)),
    )
    monkeypatch.setattr(new_video_dispatcher.push_sender, "send_push_notification", lambda *a, **kw: sent.append(1) or PushResult(sent=True, subscription_expired=False))

    new_video_dispatcher.run({}, None, now=DAY1_EVENING)

    assert sent == []


# The simultaneous-livestream notice path reuses that module's world (a dispatcher with a derived baseline schedule).
from tests.notifications.test_simultaneous_dispatch import BASELINE, follower, no_retry_pause, show, vA, vB  # noqa: E402,F401
from tests.notifications.test_simultaneous_dispatch import world as sim_world  # noqa: E402,F401


def test_the_simultaneous_notice_path_marks_a_dead_subscription(sim_world, monkeypatch):
    """A 410 on the notice marks the stored subscription inactive (same helper, same conditional update)."""
    marked = []
    monkeypatch.setattr(remote_config_store, "mark_push_subscription_inactive", lambda client_id, endpoint, *, at, reason: marked.append((client_id, endpoint, reason)) or True)
    follower(sim_world, "c1")
    sim_world.push_results = [GONE_410]

    show(sim_world, [vA(), vB()], START - timedelta(hours=2))

    assert marked == [("c1", "https://push.example/c1", "push_service_http_410")]


def test_the_simultaneous_notice_path_skips_an_inactive_subscription(sim_world, monkeypatch):
    """An already-inactive subscription is dropped before any claim or push (no endless attempts against a dead endpoint)."""
    follower(sim_world, "c1")
    real_get = sim_world._get_config
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        lambda client_id, key: ({**real_get(client_id, key), "inactiveAt": "t"} if key == "pushSubscription" and real_get(client_id, key) else real_get(client_id, key)),
    )

    summary = show(sim_world, [vA(), vB()], START - timedelta(hours=2))["simultaneous"]

    assert sim_world.pushes == [] and summary["dropped"] == 1

