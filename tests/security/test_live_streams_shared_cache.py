"""SEC-API-005 (P0): the shared-cache adapter and the wiring into GET /live-streams (roadmap MT-22).

moto stands in for S3. Two cache-store instances on one bucket model two warm API containers; a counting upstream proves
that concurrent-like multi-container traffic makes a bounded number of Holodex calls and that the metrics are emitted.
"""

from __future__ import annotations

import json

import boto3
import pytest
from moto import mock_aws

from api import api_handler, read_api
from api.holodex_client import HolodexAPIError
from api.live_streams_protection import CacheEntry
from stores.live_streams_cache_store import (
    LIVE_STREAMS_CACHE_KEY,
    LiveStreamsCacheStoreError,
    S3LiveStreamsCacheStore,
)

from .spies import event

pytestmark = pytest.mark.security

BUCKET = "yobi-analytics-history"
STREAMS = [{"videoId": "vid00000001", "creatorId": "aizawa_ema", "status": "live", "title": "t"}]


class Clock:
    def __init__(self) -> None:
        self.now = 10_000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def s3():
    with mock_aws():
        client = boto3.client("s3", region_name="ap-northeast-1")
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": "ap-northeast-1"})
        yield client


def _store(s3, clock=None, **kwargs) -> S3LiveStreamsCacheStore:
    return S3LiveStreamsCacheStore(BUCKET, s3_client=s3, clock=clock or Clock(), **kwargs)


# --- the adapter ------------------------------------------------------------------------------------------------------


def test_the_cache_object_lives_at_a_fixed_key_in_the_history_bucket(s3):
    _store(s3).write(CacheEntry(STREAMS, 10_000.0))

    body = json.loads(s3.get_object(Bucket=BUCKET, Key=LIVE_STREAMS_CACHE_KEY)["Body"].read())
    assert LIVE_STREAMS_CACHE_KEY == "live-streams/current.json"
    assert body["streams"] == STREAMS and body["fetchedAt"] == 10_000.0


def test_a_second_container_reads_what_the_first_wrote_from_the_shared_object(s3):
    _store(s3).write(CacheEntry(STREAMS, 10_000.0, cooldown_until=10_030.0, consecutive_429=1))
    other = _store(s3)

    entry = other.read()

    assert entry == CacheEntry(STREAMS, 10_000.0, cooldown_until=10_030.0, consecutive_429=1)
    assert other.last_read_source == "shared"


def test_the_l1_copy_bounds_s3_reads_and_expires(s3):
    clock = Clock()
    store = _store(s3, clock, l1_ttl_seconds=5.0)
    store.write(CacheEntry(STREAMS, 10_000.0))
    s3.delete_object(Bucket=BUCKET, Key=LIVE_STREAMS_CACHE_KEY)  # make an S3 read observable

    assert store.read() is not None and store.last_read_source == "l1"
    clock.now += 6
    assert store.read() is None and store.last_read_source == "shared"


def test_a_missing_object_is_no_entry_and_a_malformed_object_is_not_trusted(s3):
    store = _store(s3, l1_ttl_seconds=0)
    assert store.read() is None

    s3.put_object(Bucket=BUCKET, Key=LIVE_STREAMS_CACHE_KEY, Body=b'{"streams": "bogus", "fetchedAt": 1}')
    assert store.read() is None


def test_a_missing_bucket_raises_a_store_error_the_policy_can_absorb():
    with mock_aws():
        store = S3LiveStreamsCacheStore("no-such-bucket", s3_client=boto3.client("s3", region_name="ap-northeast-1"))

        with pytest.raises(LiveStreamsCacheStoreError):
            store.read()
        with pytest.raises(LiveStreamsCacheStoreError):
            store.write(CacheEntry(STREAMS, 1.0))


def test_the_default_bucket_is_the_history_bucket(s3, monkeypatch):
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)

    assert S3LiveStreamsCacheStore(s3_client=s3).bucket_name == BUCKET


# --- the wiring ---------------------------------------------------------------------------------------------------------


class CountingUpstream:
    def __init__(self, outcome) -> None:
        self.outcome = outcome
        self.calls = 0

    def __call__(self):
        self.calls += 1
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


@pytest.fixture
def containers(s3, monkeypatch):
    """Two warm containers sharing one bucket; switch(n) makes the next request land on container n."""
    clock = Clock()
    stores = [_store(s3, clock), _store(s3, clock)]
    monkeypatch.setattr("time.time", clock)
    upstream = CountingUpstream(STREAMS)
    monkeypatch.setattr(read_api, "_fetch_live_streams_from_holodex", upstream)

    def switch(n: int) -> None:
        monkeypatch.setattr(read_api, "_LIVE_STREAMS_STORE", stores[n])

    switch(0)
    return clock, upstream, switch


def test_multi_container_traffic_makes_a_bounded_number_of_upstream_calls(containers):
    clock, upstream, switch = containers

    for i in range(200):  # 200 requests bouncing between two containers inside one refresh window
        switch(i % 2)
        assert read_api.get_live_streams({}) == {"streams": STREAMS}
        clock.now += 0.1

    assert upstream.calls == 1, "the second container must be served from the shared cache the first one filled"


def test_a_new_window_triggers_one_more_refresh_not_one_per_request(containers):
    clock, upstream, switch = containers
    for i in range(10):
        switch(i % 2)
        read_api.get_live_streams({})
    clock.now += 31

    for i in range(10):
        switch(i % 2)
        read_api.get_live_streams({})

    assert upstream.calls <= 3


def test_the_metrics_are_emitted_as_structured_log_lines(containers, capsys):
    clock, upstream, switch = containers

    read_api.get_live_streams({})
    read_api.get_live_streams({})

    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith('{"liveStreamsMetric"')]
    names = [line["liveStreamsMetric"] for line in lines]
    assert names.count("request") == 2 and names.count("upstream_call") == 1 and names.count("cache_hit") == 1
    assert "refresh_latency_ms" in names


def test_an_upstream_failure_with_a_cached_result_still_answers_200_and_marks_it_no_store(containers, monkeypatch):
    clock, upstream, switch = containers
    first = api_handler.lambda_handler(event("GET /live-streams"), None)
    assert first["statusCode"] == 200 and "Cache-Control" not in first["headers"]

    clock.now += 60  # expired, inside the stale bound
    upstream.outcome = HolodexAPIError("timed out", timed_out=True)
    stale = api_handler.lambda_handler(event("GET /live-streams"), None)

    assert stale["statusCode"] == 200
    assert json.loads(stale["body"]) == {"streams": STREAMS}
    assert stale["headers"]["Cache-Control"] == "no-store", "stale data must not be extended by a downstream cache"


def test_an_upstream_failure_with_no_cached_data_is_the_explicit_503(containers):
    clock, upstream, switch = containers
    upstream.outcome = HolodexAPIError("500 boom", status_code=500)

    response = api_handler.lambda_handler(event("GET /live-streams"), None)

    assert response["statusCode"] == 503
    assert json.loads(response["body"])["code"] == "HOLODEX_UNAVAILABLE"


def test_a_429_cooldown_is_shared_between_containers(containers):
    clock, upstream, switch = containers
    switch(0)
    read_api.get_live_streams({})
    clock.now += 31
    upstream.outcome = HolodexAPIError("429", status_code=429)
    read_api.get_live_streams({})  # container 0 hits the 429 and writes the shared cooldown
    calls_after_429 = upstream.calls

    switch(1)  # container 1 must honour container 0's cooldown without calling upstream
    for _ in range(20):
        clock.now += 0.1
        read_api.get_live_streams({})

    assert upstream.calls == calls_after_429
