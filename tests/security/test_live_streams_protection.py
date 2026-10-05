"""SEC-API-005 (P0): the /live-streams upstream protection policy (roadmap MT-21).

A counting, fault-injecting upstream, an injected clock and a fake shared store prove the policy: upstream calls follow
the refresh window (not the request rate), stale-if-error is bounded, a 429 enters a shared cooldown with zero upstream
calls and a single probe at exit, retries are capped and never per client request, and nothing depends on a provider quota.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from api.holodex_client import HolodexAPIError
from api.live_streams_protection import (
    CacheEntry,
    CooldownActiveError,
    LiveStreamsProtection,
    ProtectionConfig,
)

pytestmark = pytest.mark.security

STREAMS = [{"videoId": "vid00000001", "creatorId": "aizawa_ema", "status": "live"}]
OTHER = [{"videoId": "vid00000002", "creatorId": "aizawa_ema", "status": "upcoming"}]


class Clock:
    def __init__(self, start: float = 1_000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeStore:
    """A shared cache double. `source` is what a read reports ("l1" or "shared")."""

    def __init__(self, entry: CacheEntry | None = None, source: str = "l1") -> None:
        self.entry = entry
        self.last_read_source = source
        self.reads = 0
        self.writes: list[CacheEntry] = []
        self.fail_read = False
        self.fail_write = False

    def read(self):
        self.reads += 1
        if self.fail_read:
            raise OSError("store down")
        return self.entry

    def write(self, entry: CacheEntry) -> None:
        if self.fail_write:
            raise OSError("store down")
        self.writes.append(entry)
        self.entry = entry


class Upstream:
    """A scripted fetch: each call pops the next outcome (a list result or an exception to raise); the last repeats."""

    def __init__(self, *outcomes) -> None:
        self.outcomes = list(outcomes)
        self.calls = 0

    def __call__(self):
        self.calls += 1
        outcome = self.outcomes.pop(0) if len(self.outcomes) > 1 else self.outcomes[0]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class Events:
    def __init__(self) -> None:
        self.log: list[tuple[str, dict]] = []

    def __call__(self, event: str, **fields) -> None:
        self.log.append((event, fields))

    def count(self, name: str) -> int:
        return sum(1 for event, _ in self.log if event == name)

    def fields(self, name: str) -> list[dict]:
        return [f for event, f in self.log if event == name]


def make(*outcomes, store=None, config=None, clock=None, rand=lambda: 0.5):
    clock = clock or Clock()
    store = store if store is not None else FakeStore()
    events, sleeps = Events(), []
    upstream = Upstream(*outcomes)
    protection = LiveStreamsProtection(
        store=store,
        fetch=upstream,
        config=config or ProtectionConfig(),
        clock=clock,
        sleep=sleeps.append,
        emit=events,
        rand=rand,
    )
    return protection, upstream, store, clock, events, sleeps


def rate_limited(retry_after=None) -> HolodexAPIError:
    return HolodexAPIError("429 slow down", status_code=429, retry_after_seconds=retry_after)


def timeout() -> HolodexAPIError:
    return HolodexAPIError("timed out", timed_out=True)


def server_error() -> HolodexAPIError:
    return HolodexAPIError("500 boom", status_code=500)


# --- fresh hit / refresh window ---------------------------------------------------------------------------------------


def test_the_first_request_refreshes_and_a_second_within_the_window_is_a_cache_hit_with_no_upstream_call():
    protection, upstream, store, clock, events, _ = make(STREAMS)

    first = protection.get()
    clock.advance(10)
    second = protection.get()

    assert (first.source, second.source) == ("refreshed", "fresh_cache")
    assert upstream.calls == 1
    assert events.count("request") == 2 and events.count("cache_hit") == 1 and events.count("upstream_call") == 1


def test_an_expired_entry_triggers_exactly_one_refresh_per_window():
    protection, upstream, _, clock, _, _ = make(STREAMS, OTHER)

    protection.get()
    clock.advance(31)
    refreshed = protection.get()

    assert refreshed.streams == OTHER and upstream.calls == 2


def test_a_bot_loop_of_thousands_of_requests_makes_a_bounded_number_of_upstream_calls():
    protection, upstream, _, clock, events, _ = make(STREAMS)

    for _ in range(5_000):  # 5,000 requests over 5 simulated minutes
        protection.get()
        clock.advance(0.06)

    windows = 300 / 30
    assert upstream.calls <= windows + 1, "upstream calls must follow the refresh window, not the request rate"
    assert events.count("request") == 5_000
    assert events.count("upstream_call") / events.count("request") < 0.01, "amplification ratio must be far below 1"


def test_a_hit_from_the_shared_store_is_counted_as_a_coalesced_request():
    shared = FakeStore(CacheEntry(STREAMS, fetched_at=1_000.0), source="shared")
    protection, upstream, _, clock, events, _ = make(STREAMS, store=shared)
    clock.advance(5)

    protection.get()

    assert upstream.calls == 0 and events.count("coalesced_request") == 1


# --- stale-if-error ------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("failure", [timeout(), server_error(), HolodexAPIError("malformed response")])
def test_a_temporary_upstream_failure_serves_bounded_stale_data_and_says_so(failure):
    protection, _, _, clock, events, _ = make(STREAMS, failure, config=ProtectionConfig(retry_attempts=0))
    protection.get()
    clock.advance(120)  # expired, but inside the 300 s stale bound

    result = protection.get()

    assert result.stale and result.source == "stale_cache" and result.streams == STREAMS
    assert events.count("stale_served") == 1


def test_beyond_the_stale_bound_the_original_upstream_error_is_raised_not_fabricated_data():
    protection, _, _, clock, _, _ = make(STREAMS, server_error(), config=ProtectionConfig(retry_attempts=0))
    protection.get()
    clock.advance(301)

    with pytest.raises(HolodexAPIError, match="500 boom"):
        protection.get()


def test_with_no_cached_data_and_an_upstream_failure_the_error_is_raised():
    protection, _, _, _, _, _ = make(timeout(), config=ProtectionConfig(retry_attempts=0))

    with pytest.raises(HolodexAPIError, match="timed out"):
        protection.get()


# --- upstream 429: shared cooldown ----------------------------------------------------------------------------------------


def test_a_429_is_never_retried_per_request_even_with_retries_configured():
    protection, upstream, _, _, events, _ = make(rate_limited(), config=ProtectionConfig(retry_attempts=3))

    with pytest.raises(HolodexAPIError):
        protection.get()

    assert upstream.calls == 1
    assert events.count("upstream_429") == 1 and events.count("cooldown_entered") == 1


def test_during_a_cooldown_there_are_zero_upstream_calls_and_one_probe_when_it_ends():
    protection, upstream, store, clock, events, _ = make(STREAMS, rate_limited(), STREAMS)
    protection.get()  # fresh data cached
    clock.advance(31)
    stale = protection.get()  # refresh -> 429 -> cooldown, stale served
    assert stale.stale and upstream.calls == 2

    calls_before = upstream.calls
    for _ in range(500):  # a bot hammers the route during the cooldown
        clock.advance(0.01)
        assert protection.get().stale
    assert upstream.calls == calls_before, "no upstream call may happen during the cooldown"
    assert events.count("cooldown_active") == 500

    clock.advance(40)  # the 30 s base cooldown is over: ONE probe
    protection.get()
    assert upstream.calls == calls_before + 1
    assert store.entry.consecutive_429 == 0 and store.entry.cooldown_until is None


def test_during_a_cooldown_with_no_usable_data_the_request_fails_explicitly_without_calling_upstream():
    protection, upstream, _, clock, _, _ = make(rate_limited())
    with pytest.raises(HolodexAPIError):
        protection.get()
    clock.advance(1)

    with pytest.raises(CooldownActiveError):
        protection.get()

    assert upstream.calls == 1
    assert issubclass(CooldownActiveError, HolodexAPIError), "must map to the existing 503 HOLODEX_UNAVAILABLE"


def test_repeated_429s_grow_the_cooldown_exponentially_up_to_the_ceiling():
    protection, _, store, clock, events, _ = make(
        rate_limited(), config=ProtectionConfig(cooldown_base_seconds=30, cooldown_max_seconds=100)
    )
    for _ in range(5):
        with pytest.raises(HolodexAPIError):
            protection.get()
        clock.advance(store.entry.cooldown_until - clock.now + 0.1)

    assert [f["duration_seconds"] for f in events.fields("cooldown_entered")] == [30.0, 60.0, 100.0, 100.0, 100.0]


def test_retry_after_is_honoured_and_clamped_to_the_ceiling():
    protection, _, store, clock, _, _ = make(rate_limited(retry_after=45))
    with pytest.raises(HolodexAPIError):
        protection.get()
    assert store.entry.cooldown_until == pytest.approx(clock.now + 45)

    huge, _, store2, clock2, _, _ = make(rate_limited(retry_after=99_999))
    with pytest.raises(HolodexAPIError):
        huge.get()
    assert store2.entry.cooldown_until == pytest.approx(clock2.now + 300)


# --- bounded timeout / retries ----------------------------------------------------------------------------------------------


def test_retries_stay_inside_one_refresh_with_exponential_backoff_and_a_cap():
    protection, upstream, _, _, events, sleeps = make(
        server_error(), config=ProtectionConfig(retry_attempts=2, retry_backoff_base_seconds=1)
    )

    with pytest.raises(HolodexAPIError):
        protection.get()

    assert upstream.calls == 3  # 1 + retry_attempts, never more
    assert sleeps == [1.0, 2.0]  # base * 2**attempt with the injected midpoint jitter
    assert events.count("upstream_error") == 3


def test_a_retry_that_succeeds_ends_the_refresh():
    protection, upstream, _, _, _, _ = make(timeout(), STREAMS, config=ProtectionConfig(retry_attempts=2))

    result = protection.get()

    assert result.source == "refreshed" and upstream.calls == 2


@pytest.mark.parametrize(
    "fatal", [HolodexAPIError("401 invalid key", status_code=401), HolodexAPIError("403", status_code=403)]
)
def test_a_non_429_client_error_is_not_retried(fatal):
    protection, upstream, _, _, _, _ = make(fatal, config=ProtectionConfig(retry_attempts=3))

    with pytest.raises(HolodexAPIError):
        protection.get()

    assert upstream.calls == 1


def test_the_refresh_deadline_stops_further_retries():
    clock = Clock()

    class SlowUpstream(Upstream):
        def __call__(self):
            clock.advance(19)  # one attempt plus its backoff already reaches the 20 s deadline
            return super().__call__()

    events, sleeps = Events(), []
    upstream = SlowUpstream(server_error())
    protection = LiveStreamsProtection(
        store=FakeStore(),
        fetch=upstream,
        config=ProtectionConfig(retry_attempts=3),
        clock=clock,
        sleep=sleeps.append,
        emit=events,
        rand=lambda: 0.5,
    )

    with pytest.raises(HolodexAPIError):
        protection.get()

    assert upstream.calls == 1, "the hard deadline must prevent a second attempt"


def test_a_timeout_is_counted_separately_from_other_errors():
    protection, _, _, _, events, _ = make(timeout(), config=ProtectionConfig(retry_attempts=0))

    with pytest.raises(HolodexAPIError):
        protection.get()

    assert events.count("upstream_timeout") == 1 and events.count("upstream_error") == 0


# --- store failures never fail a request --------------------------------------------------------------------------------------


def test_a_failing_cache_read_degrades_to_an_upstream_refresh():
    store = FakeStore()
    store.fail_read = True
    protection, upstream, _, _, events, _ = make(STREAMS, store=store)

    result = protection.get()

    assert result.streams == STREAMS and upstream.calls == 1
    assert events.count("store_error") >= 1


def test_a_failing_cache_write_does_not_fail_a_request_that_already_has_an_answer():
    store = FakeStore()
    store.fail_write = True
    protection, _, _, _, events, _ = make(STREAMS, store=store)

    assert protection.get().streams == STREAMS
    assert events.count("store_error") == 1


# --- configuration / no provider constant -------------------------------------------------------------------------------------


def test_the_refresh_window_comes_from_configuration():
    env = {"LIVE_STREAMS_REFRESH_WINDOW_SECONDS": "45", "LIVE_STREAMS_MAX_STALE_SECONDS": "900", "LIVE_STREAMS_RETRY_ATTEMPTS": "0"}

    config = ProtectionConfig.from_environment(env)

    assert (config.refresh_window_seconds, config.max_stale_seconds, config.retry_attempts) == (45.0, 900.0, 0)


@pytest.mark.parametrize(
    "bad",
    [
        {"LIVE_STREAMS_REFRESH_WINDOW_SECONDS": "abc"},
        {"LIVE_STREAMS_REFRESH_WINDOW_SECONDS": "-5"},
        {"LIVE_STREAMS_RETRY_ATTEMPTS": "99"},
        {"LIVE_STREAMS_MAX_STALE_SECONDS": "1"},
    ],
)
def test_an_invalid_configuration_falls_back_to_the_defaults_instead_of_failing(bad):
    assert ProtectionConfig.from_environment(bad) == ProtectionConfig()


def test_no_provider_limit_constant_exists_in_the_policy_code():
    source = (Path(__file__).resolve().parents[2] / "src" / "api" / "live_streams_protection.py").read_text(encoding="utf-8")

    for forbidden in ("80 req", "reqs per", "per 2 minutes", "120 req"):
        assert forbidden not in source


# --- cache entry (de)serialization --------------------------------------------------------------------------------------------


def test_a_cache_entry_round_trips_through_json():
    entry = CacheEntry(STREAMS, 1_000.5, cooldown_until=1_030.0, consecutive_429=2)

    assert CacheEntry.from_json(entry.to_json()) == entry


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "not json",
        "[]",
        "{}",
        '{"streams": "x", "fetchedAt": 1}',
        '{"streams": [1], "fetchedAt": 1}',
        '{"streams": [], "fetchedAt": "now"}',
        '{"streams": [], "fetchedAt": 1, "consecutive429": -1}',
        '{"streams": [], "fetchedAt": true}',
    ],
)
def test_a_malformed_stored_entry_is_rejected_not_trusted(raw):
    assert CacheEntry.from_json(raw) is None
