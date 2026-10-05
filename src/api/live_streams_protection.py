"""`/live-streams` upstream protection policy (SEC-API-005, roadmap MT-21).

Pure logic: the shared cache, the clock, the sleeper and the upstream fetch are all injected, so the whole policy is
deterministic and unit-testable. It decouples client request volume from Holodex upstream volume:

    request -> fresh cache hit?  -> serve it (no upstream call)
            -> shared cooldown active? -> no upstream call; serve bounded-stale data or fail explicitly
            -> otherwise ONE refresh operation (bounded timeout/retries) -> write the shared cache
               - upstream 429 -> enter a shared exponential cooldown (honouring Retry-After), never retry per request
               - other failure -> serve bounded-stale data, or fail explicitly with the original error

Nothing here knows or assumes a Holodex quota; the refresh window, stale bound, cooldown and retry cap are configuration.
Strict cross-container single-flight (a distributed lease) is a P1 follow-on and is not implemented here: launch
coalescing is the shared cache plus per-container serialization (a Lambda container runs one request at a time).
"""

from __future__ import annotations

import json
import os
import random
import time
from dataclasses import dataclass, replace
from typing import Any, Callable, Mapping, Protocol

from api.holodex_client import HolodexAPIError

# Metric/event names (emitted as structured log lines; see emit_metric).
M_REQUEST = "request"  # every /live-streams request: the denominator of the amplification ratio
M_CACHE_HIT = "cache_hit"
M_CACHE_MISS = "cache_miss"
M_UPSTREAM_CALL = "upstream_call"  # the numerator of the amplification ratio
M_UPSTREAM_429 = "upstream_429"
M_UPSTREAM_TIMEOUT = "upstream_timeout"
M_UPSTREAM_ERROR = "upstream_error"
M_COALESCED = "coalesced_request"  # served from a shared-cache entry another request/container refreshed
M_STALE_SERVED = "stale_served"
M_REFRESH_LATENCY = "refresh_latency_ms"
M_COOLDOWN_ENTERED = "cooldown_entered"
M_COOLDOWN_ACTIVE = "cooldown_active"
M_STORE_ERROR = "store_error"


@dataclass(frozen=True)
class ProtectionConfig:
    """Tunable parameters. None is derived from, or hard-coded to, any observed provider limit."""

    refresh_window_seconds: float = 30.0  # a refresh happens at most once per window (per shared-cache view)
    max_stale_seconds: float = 300.0  # bounded stale-if-error: beyond this a live stream may already have ended
    cooldown_base_seconds: float = 30.0  # first cooldown after an upstream 429 (when no Retry-After is sent)
    cooldown_max_seconds: float = 300.0  # ceiling on cooldown growth
    retry_attempts: int = 0  # EXTRA attempts inside one refresh operation (0 = none, the V1 default). Never per client request.
    retry_backoff_base_seconds: float = 1.0  # exponential backoff base between attempts (with jitter)
    refresh_deadline_seconds: float = 20.0  # hard total deadline for one refresh operation

    def __post_init__(self) -> None:
        if self.refresh_window_seconds <= 0:
            raise ValueError("refresh_window_seconds must be positive")
        if self.max_stale_seconds < self.refresh_window_seconds:
            raise ValueError("max_stale_seconds must be at least refresh_window_seconds")
        if self.cooldown_base_seconds <= 0 or self.cooldown_max_seconds < self.cooldown_base_seconds:
            raise ValueError("cooldown_max_seconds must be at least cooldown_base_seconds, which must be positive")
        if not 0 <= self.retry_attempts <= 3:
            raise ValueError("retry_attempts must be between 0 and 3")
        if self.retry_backoff_base_seconds < 0 or self.refresh_deadline_seconds <= 0:
            raise ValueError("backoff must be non-negative and the deadline positive")

    @classmethod
    def from_environment(cls, environ: Mapping[str, str] | None = None) -> "ProtectionConfig":
        """Read LIVE_STREAMS_* overrides; an unset, blank or invalid set falls back to the defaults (never raises)."""
        env = os.environ if environ is None else environ
        defaults = cls()
        try:
            return cls(
                refresh_window_seconds=_number(env, "LIVE_STREAMS_REFRESH_WINDOW_SECONDS", defaults.refresh_window_seconds),
                max_stale_seconds=_number(env, "LIVE_STREAMS_MAX_STALE_SECONDS", defaults.max_stale_seconds),
                cooldown_base_seconds=_number(env, "LIVE_STREAMS_COOLDOWN_BASE_SECONDS", defaults.cooldown_base_seconds),
                cooldown_max_seconds=_number(env, "LIVE_STREAMS_COOLDOWN_MAX_SECONDS", defaults.cooldown_max_seconds),
                retry_attempts=int(_number(env, "LIVE_STREAMS_RETRY_ATTEMPTS", defaults.retry_attempts)),
                retry_backoff_base_seconds=_number(env, "LIVE_STREAMS_RETRY_BACKOFF_SECONDS", defaults.retry_backoff_base_seconds),
                refresh_deadline_seconds=_number(env, "LIVE_STREAMS_REFRESH_DEADLINE_SECONDS", defaults.refresh_deadline_seconds),
            )
        except ValueError:
            return defaults


def _number(env: Mapping[str, str], name: str, default: float) -> float:
    raw = (env.get(name) or "").strip()
    return float(raw) if raw else float(default)


@dataclass(frozen=True)
class CacheEntry:
    """What the shared cache holds: the last good normalized result and the shared cooldown state."""

    streams: list[dict[str, Any]] | None  # None until a refresh has ever succeeded
    fetched_at: float | None  # epoch seconds of the last successful refresh
    cooldown_until: float | None = None  # epoch seconds; no upstream calls before this
    consecutive_429: int = 0

    def to_json(self) -> str:
        return json.dumps(
            {
                "streams": self.streams,
                "fetchedAt": self.fetched_at,
                "cooldownUntil": self.cooldown_until,
                "consecutive429": self.consecutive_429,
            }
        )

    @classmethod
    def from_json(cls, raw: str | bytes) -> "CacheEntry | None":
        """Parse a stored entry; any malformed or wrongly-typed value yields None (stored data is untrusted)."""
        try:
            data = json.loads(raw)
            streams, fetched_at = data["streams"], data["fetchedAt"]
            cooldown, count = data.get("cooldownUntil"), data.get("consecutive429", 0)
        except (ValueError, KeyError, TypeError):
            return None
        if streams is not None and not (isinstance(streams, list) and all(isinstance(s, dict) for s in streams)):
            return None
        for number in (fetched_at, cooldown):
            if number is not None and (isinstance(number, bool) or not isinstance(number, (int, float))):
                return None
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            return None
        return cls(streams=streams, fetched_at=fetched_at, cooldown_until=cooldown, consecutive_429=count)


class CacheStore(Protocol):
    """The shared cache. `last_read_source` ("l1" or "shared") lets metrics tell a coalesced request from a local hit."""

    last_read_source: str

    def read(self) -> CacheEntry | None: ...

    def write(self, entry: CacheEntry) -> None: ...


@dataclass(frozen=True)
class ProtectedResult:
    streams: list[dict[str, Any]]
    source: str  # "fresh_cache" | "refreshed" | "stale_cache"
    stale: bool
    age_seconds: float | None


def emit_metric(event: str, **fields: Any) -> None:
    """One structured log line per metric/event (JSON, no secrets, no identifiers) for CloudWatch Logs Insights."""
    print(json.dumps({"liveStreamsMetric": event, **fields}, default=str))


class LiveStreamsProtection:
    """The decision logic above, with every side effect injected."""

    def __init__(
        self,
        *,
        store: CacheStore,
        fetch: Callable[[], list[dict[str, Any]]],
        config: ProtectionConfig | None = None,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
        emit: Callable[..., None] = emit_metric,
        rand: Callable[[], float] = random.random,
    ) -> None:
        self._store = store
        self._fetch = fetch
        self._config = config or ProtectionConfig()
        self._clock = clock
        self._sleep = sleep
        self._emit = emit
        self._rand = rand

    # ------------------------------------------------------------------ public

    def get(self) -> ProtectedResult:
        """Serve the best allowed answer; raise the original upstream error only when no usable data exists."""
        cfg, now = self._config, self._clock()
        self._emit(M_REQUEST)
        entry = self._read_entry()

        if entry is not None and entry.streams is not None and entry.fetched_at is not None:
            age = now - entry.fetched_at
            if 0 <= age < cfg.refresh_window_seconds:
                self._emit(M_CACHE_HIT, source=getattr(self._store, "last_read_source", "unknown"), age_seconds=round(age, 3))
                if getattr(self._store, "last_read_source", "") == "shared":
                    self._emit(M_COALESCED)
                return ProtectedResult(entry.streams, "fresh_cache", False, age)
        self._emit(M_CACHE_MISS)

        if entry is not None and entry.cooldown_until is not None and now < entry.cooldown_until:
            self._emit(M_COOLDOWN_ACTIVE, remaining_seconds=round(entry.cooldown_until - now, 3))
            stale = self._stale(entry, now)
            if stale is not None:
                return stale
            raise CooldownActiveError("Holodex is cooling down after a rate limit and no cached data is usable")

        return self._refresh(entry, now)

    # ------------------------------------------------------------------ internals

    def _read_entry(self) -> CacheEntry | None:
        try:
            return self._store.read()
        except Exception as exc:  # noqa: BLE001 - a broken cache must degrade to "no entry", never fail the request
            self._emit(M_STORE_ERROR, operation="read", error=type(exc).__name__)
            return None

    def _write_entry(self, entry: CacheEntry) -> None:
        try:
            self._store.write(entry)
        except Exception as exc:  # noqa: BLE001 - failing to cache must not fail a request that already has an answer
            self._emit(M_STORE_ERROR, operation="write", error=type(exc).__name__)

    def _stale(self, entry: CacheEntry | None, now: float) -> ProtectedResult | None:
        """Bounded stale-if-error: usable only inside max_stale_seconds; never presented as fresh."""
        if entry is None or entry.streams is None or entry.fetched_at is None:
            return None
        age = now - entry.fetched_at
        if age < 0 or age > self._config.max_stale_seconds:
            return None
        self._emit(M_STALE_SERVED, age_seconds=round(age, 3))
        return ProtectedResult(entry.streams, "stale_cache", True, age)

    def _refresh(self, entry: CacheEntry | None, started: float) -> ProtectedResult:
        """ONE refresh operation: retries (capped, backed off, deadline-bound) happen only here, never per client request."""
        cfg = self._config
        attempts = 1 + cfg.retry_attempts
        last_error: Exception | None = None
        for attempt in range(attempts):
            self._emit(M_UPSTREAM_CALL, attempt=attempt + 1)
            call_started = self._clock()
            try:
                streams = self._fetch()
            except Exception as exc:  # noqa: BLE001 - classified below; unknown errors are treated as upstream failures
                last_error = exc
                self._emit(M_REFRESH_LATENCY, value=round((self._clock() - call_started) * 1000, 1), outcome="error")
                kind = _classify(exc)
                if kind == "rate_limited":
                    self._emit(M_UPSTREAM_429)
                    return self._after_429(entry, exc, started)
                self._emit(M_UPSTREAM_TIMEOUT if kind == "timeout" else M_UPSTREAM_ERROR, error=type(exc).__name__)
                if kind == "fatal" or attempt == attempts - 1:
                    break
                backoff = cfg.retry_backoff_base_seconds * (2**attempt) * (0.5 + self._rand())
                if (self._clock() - started) + backoff >= cfg.refresh_deadline_seconds:
                    break
                self._sleep(backoff)
                continue
            self._emit(M_REFRESH_LATENCY, value=round((self._clock() - call_started) * 1000, 1), outcome="ok")
            fresh = CacheEntry(streams=streams, fetched_at=self._clock(), cooldown_until=None, consecutive_429=0)
            self._write_entry(fresh)
            return ProtectedResult(streams, "refreshed", False, 0.0)

        stale = self._stale(entry, self._clock())
        if stale is not None:
            return stale
        assert last_error is not None
        raise last_error

    def _after_429(self, entry: CacheEntry | None, exc: Exception, started: float) -> ProtectedResult:
        """Upstream 429: no per-request retry. Enter the shared cooldown, then serve bounded-stale data or fail explicitly."""
        cfg = self._config
        previous = entry.consecutive_429 if entry is not None else 0
        retry_after = getattr(exc, "retry_after_seconds", None)
        if retry_after is not None:
            duration = min(max(retry_after, 0.0), cfg.cooldown_max_seconds)
        else:
            duration = min(cfg.cooldown_max_seconds, cfg.cooldown_base_seconds * (2**previous) * (0.5 + self._rand()))
        until = self._clock() + duration
        base = entry if entry is not None else CacheEntry(streams=None, fetched_at=None)
        self._write_entry(replace(base, cooldown_until=until, consecutive_429=previous + 1))
        self._emit(M_COOLDOWN_ENTERED, duration_seconds=round(duration, 3), consecutive_429=previous + 1)
        stale = self._stale(entry, self._clock())
        if stale is not None:
            return stale
        raise exc


class CooldownActiveError(HolodexAPIError):
    """Raised during a cooldown when no usable cached data exists; a HolodexAPIError, so api_handler answers it with the
    existing 503 HOLODEX_UNAVAILABLE."""


def _classify(exc: Exception) -> str:
    """"rate_limited" (429), "timeout", "retryable" (other upstream/transient) or "fatal" (retrying cannot help)."""
    status = getattr(exc, "status_code", None)
    if status == 429:
        return "rate_limited"
    if getattr(exc, "timed_out", False):
        return "timeout"
    if status is not None and 400 <= status < 500:
        return "fatal"  # a 4xx other than 429 (bad key, bad request) will not improve on retry
    if type(exc).__name__ in {"HolodexNormalizationError", "MissingHolodexApiKeyError"}:
        return "fatal"
    return "retryable"
