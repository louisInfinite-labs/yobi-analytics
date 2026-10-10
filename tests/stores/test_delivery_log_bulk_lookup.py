"""delivered_video_ids: the bulk equivalent of already_delivered(), used by the dispatcher once per client per run."""

from datetime import timedelta

import boto3
import pytest
from botocore.exceptions import ClientError

from stores import notification_delivery_log_store as store
from stores.notification_delivery_log_store import (
    NOTIFICATION_DELIVERY_LOG_TABLE,
    NotificationDeliveryLogStoreError,
    already_delivered,
    confirm_delivered,
    delivered_video_ids,
    mark_delivered,
    mark_suppressed,
    release_claim,
)

from .test_notification_delivery_log_store import AWS_REGION, NOW, delivery_log_table  # noqa: F401  (fixture)


@pytest.fixture(autouse=True)
def fresh_settled_cache():
    """The settled-row cache is module state: start and finish every test with it empty."""
    store._settled_cache.clear()
    yield
    store._settled_cache.clear()


class SpyResource:
    """Wraps the real (moto) resource and counts BatchGetItem requests, so a test can prove how many round trips were made."""

    def __init__(self):
        self.real = boto3.resource("dynamodb", region_name=AWS_REGION)
        self.batch_calls = []

    def Table(self, name):  # noqa: N802 -- boto3's own method name
        return self.real.Table(name)

    def batch_get_item(self, **kwargs):
        self.batch_calls.append(sum(len(v["Keys"]) for v in kwargs["RequestItems"].values()))
        return self.real.batch_get_item(**kwargs)


@pytest.fixture
def spy(monkeypatch, delivery_log_table):  # noqa: F811
    resource = SpyResource()
    monkeypatch.setattr(store, "_resource", lambda: resource)
    return resource


def test_no_ids_means_no_request_and_an_empty_result(spy):
    assert delivered_video_ids("c1", [], now=NOW) == set()
    assert spy.batch_calls == []


def test_it_answers_exactly_what_already_delivered_answers_for_every_kind_of_row(spy):
    mark_delivered("c1", "claimed-live", NOW.isoformat(), now=NOW)
    mark_delivered("c1", "claimed-expired", (NOW - timedelta(minutes=30)).isoformat(), now=NOW - timedelta(minutes=30))
    mark_delivered("c1", "delivered", NOW.isoformat(), now=NOW)
    confirm_delivered("c1", "delivered", NOW.isoformat())
    mark_suppressed("c1", "suppressed", NOW.isoformat())
    mark_delivered("c2", "other-clients-row", NOW.isoformat(), now=NOW)
    ids = ["claimed-live", "claimed-expired", "delivered", "suppressed", "never-seen", "other-clients-row"]

    bulk = delivered_video_ids("c1", ids, now=NOW)

    assert bulk == {video_id for video_id in ids if already_delivered("c1", video_id, now=NOW)}
    assert bulk == {"claimed-live", "delivered", "suppressed"}  # an expired claim and another client's row do not count


def test_more_than_one_hundred_ids_are_split_into_batches_of_at_most_one_hundred(spy):
    ids = [f"v{i:03d}" for i in range(250)]
    for video_id in ids:
        mark_suppressed("c1", video_id, NOW.isoformat())

    assert delivered_video_ids("c1", ids, now=NOW) == set(ids)
    assert spy.batch_calls == [100, 100, 50]  # 3 round trips instead of 250


def test_duplicate_ids_are_looked_up_once_not_rejected_by_dynamodb(spy):
    mark_suppressed("c1", "v1", NOW.isoformat())

    assert delivered_video_ids("c1", ["v1", "v1", "v2", "v2"], now=NOW) == {"v1"}
    assert spy.batch_calls == [2]


def test_settled_rows_are_not_read_again_on_the_next_run(spy):
    mark_suppressed("c1", "v1", NOW.isoformat())
    mark_delivered("c1", "v2", NOW.isoformat(), now=NOW)
    confirm_delivered("c1", "v2", NOW.isoformat())

    assert delivered_video_ids("c1", ["v1", "v2"], now=NOW) == {"v1", "v2"}
    assert delivered_video_ids("c1", ["v1", "v2"], now=NOW) == {"v1", "v2"}

    assert spy.batch_calls == [2]  # the second run answered both from the settled cache without any read


def test_only_the_new_ids_are_read_once_the_old_ones_are_settled(spy):
    mark_suppressed("c1", "old", NOW.isoformat())
    delivered_video_ids("c1", ["old"], now=NOW)
    mark_suppressed("c1", "fresh", NOW.isoformat())

    assert delivered_video_ids("c1", ["old", "fresh"], now=NOW) == {"old", "fresh"}
    assert spy.batch_calls == [1, 1]  # the second call read only "fresh"


def test_a_live_claim_is_never_cached_so_a_release_is_seen_on_the_next_run(spy):
    mark_delivered("c1", "v1", NOW.isoformat(), now=NOW)
    assert delivered_video_ids("c1", ["v1"], now=NOW) == {"v1"}

    release_claim("c1", "v1")

    assert delivered_video_ids("c1", ["v1"], now=NOW) == set()  # re-read, not remembered
    assert spy.batch_calls == [1, 1]


def test_a_missing_row_is_never_cached_as_settled(spy):
    assert delivered_video_ids("c1", ["v1"], now=NOW) == set()
    mark_suppressed("c1", "v1", NOW.isoformat())

    assert delivered_video_ids("c1", ["v1"], now=NOW) == {"v1"}


def test_the_settled_cache_expires_so_a_deliberately_deleted_row_is_honoured_again(spy, monkeypatch):
    clock = {"now": 1000.0}
    monkeypatch.setattr(store.time, "monotonic", lambda: clock["now"])
    monkeypatch.setattr(store.random, "random", lambda: 0.5)  # jitter factor exactly 1.0 x TTL
    mark_suppressed("c1", "v1", NOW.isoformat())
    delivered_video_ids("c1", ["v1"], now=NOW)
    release_claim("c1", "v1")  # an operator removing the row (release_claim is the same DeleteItem)

    clock["now"] += store._SETTLED_CACHE_TTL_SECONDS - 1
    assert delivered_video_ids("c1", ["v1"], now=NOW) == {"v1"}  # still inside the TTL: remembered

    clock["now"] += 2
    assert delivered_video_ids("c1", ["v1"], now=NOW) == set()  # TTL passed: re-read, the row is really gone


def test_each_clients_cache_expires_at_a_different_time_within_half_to_one_and_a_half_ttl(spy, monkeypatch):
    """Without jitter every client's cache would expire in the same run and that run would re-read all of them."""
    monkeypatch.setattr(store.time, "monotonic", lambda: 1000.0)
    draws = iter([0.0, 0.5, 0.999])
    monkeypatch.setattr(store.random, "random", lambda: next(draws))
    for client_id in ("c1", "c2", "c3"):
        mark_suppressed(client_id, "v1", NOW.isoformat())
        delivered_video_ids(client_id, ["v1"], now=NOW)

    lifetimes = [store._settled_cache[c][0] - 1000.0 for c in ("c1", "c2", "c3")]

    assert lifetimes[0] == pytest.approx(0.5 * store._SETTLED_CACHE_TTL_SECONDS)
    assert lifetimes[1] == pytest.approx(1.0 * store._SETTLED_CACHE_TTL_SECONDS)
    assert lifetimes[2] == pytest.approx(1.499 * store._SETTLED_CACHE_TTL_SECONDS)
    assert len(set(lifetimes)) == 3


def test_ids_that_left_the_candidate_window_are_pruned_from_the_cache(spy):
    mark_suppressed("c1", "gone", NOW.isoformat())
    delivered_video_ids("c1", ["gone"], now=NOW)

    delivered_video_ids("c1", ["other"], now=NOW)

    assert store._settled_cache["c1"][1] == set()


def test_each_client_has_its_own_cache(spy):
    mark_suppressed("c1", "v1", NOW.isoformat())
    assert delivered_video_ids("c1", ["v1"], now=NOW) == {"v1"}

    assert delivered_video_ids("c2", ["v1"], now=NOW) == set()  # c2 has no row; c1's settled cache must not leak


class FlakyResource:
    """A resource whose BatchGetItem leaves part of each of the first `leftover_rounds` requests unprocessed."""

    def __init__(self, rows, leftover_rounds):
        self.rows, self.leftover_rounds, self.calls = rows, leftover_rounds, 0

    def batch_get_item(self, RequestItems):  # noqa: N803 -- boto3's own keyword
        self.calls += 1
        table, spec = next(iter(RequestItems.items()))
        keys = spec["Keys"]
        if self.calls <= self.leftover_rounds and len(keys) > 1:
            done, left = keys[:1], keys[1:]
            responses = [r for r in self.rows if r["videoId"] == done[0]["videoId"]]
            return {"Responses": {table: responses}, "UnprocessedKeys": {table: {**spec, "Keys": left}}}
        wanted = {k["videoId"] for k in keys}
        return {"Responses": {table: [r for r in self.rows if r["videoId"] in wanted]}, "UnprocessedKeys": {}}


def test_unprocessed_keys_are_retried_until_every_row_is_returned(monkeypatch):
    rows = [{"videoId": f"v{i}", "status": "suppressed"} for i in range(3)]
    flaky = FlakyResource(rows, leftover_rounds=2)
    monkeypatch.setattr(store, "_resource", lambda: flaky)
    monkeypatch.setattr(store.time, "sleep", lambda seconds: None)

    assert delivered_video_ids("c1", ["v0", "v1", "v2"], now=NOW) == {"v0", "v1", "v2"}
    assert flaky.calls == 3


def test_keys_that_stay_unprocessed_raise_instead_of_being_treated_as_not_delivered(monkeypatch):
    flaky = FlakyResource([], leftover_rounds=99)
    monkeypatch.setattr(store, "_resource", lambda: flaky)
    monkeypatch.setattr(store.time, "sleep", lambda seconds: None)

    with pytest.raises(NotificationDeliveryLogStoreError, match="unprocessed"):
        delivered_video_ids("c1", [f"v{i}" for i in range(8)], now=NOW)  # silently answering "not delivered" here would re-send notifications


def test_a_dynamodb_error_is_wrapped(monkeypatch):
    class Broken:
        def batch_get_item(self, **kwargs):
            raise ClientError({"Error": {"Code": "ProvisionedThroughputExceededException", "Message": "slow down"}}, "BatchGetItem")

    monkeypatch.setattr(store, "_resource", lambda: Broken())

    with pytest.raises(NotificationDeliveryLogStoreError, match=NOTIFICATION_DELIVERY_LOG_TABLE):
        delivered_video_ids("c1", ["v1"], now=NOW)
