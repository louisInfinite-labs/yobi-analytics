"""A tiny bounded thread pool for the dispatcher's per-recipient work (DynamoDB reads, the delivery-log claim, and the Web Push request).

Why it exists: a reminder run used to serve its recipients one after another. A push takes about 0.1-0.3 s and a push service may take up to the 10 s
request timeout, so a creator with thousands of followers starting at one minute needed more than the Lambda's 300 s: the run was killed and the
remaining reminders (which are never replayed on the on-time path) were lost. Serving N recipients with W workers divides that wall time by about W
without changing anything else: every recipient's work is already independent and idempotent (the delivery log's atomic claim).

`run_ordered` returns results in the ITEMS' order (not completion order) and never raises for one item's failure: the exception is returned in its
slot, so the caller decides (isolate it, count it, or re-raise). With one worker (or one item) it runs inline on the calling thread, which keeps
single-recipient runs and the test suite deterministic and free of thread start-up cost.
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Sequence, TypeVar

T = TypeVar("T")

# One pool per worker count, created on first use and kept for the life of the container. The pool's threads keep their per-thread boto3 resources (and
# TLS connections) warm from one invocation to the next instead of rebuilding up to 16 of them every due minute. A Lambda container runs one invocation at a
# time, so a pool is never used by two runs at once.
_pools: dict[int, ThreadPoolExecutor] = {}
_pools_lock = threading.Lock()


def _pool(workers: int) -> ThreadPoolExecutor:
    """The container's long-lived pool of `workers` threads."""
    with _pools_lock:
        pool = _pools.get(workers)
        if pool is None:
            pool = _pools[workers] = ThreadPoolExecutor(max_workers=workers, thread_name_prefix=f"yobi-pool-{workers}")
        return pool


DEFAULT_WORKERS = 16  # about 50 recipients per second at ~0.3 s each: 300 s is ~15,000 recipients, far beyond one minute's realistic fan-out


def run_ordered(fn: Callable[[Any], T], items: Sequence[Any], *, workers: int) -> list[T | BaseException]:
    """Apply `fn` to every item with at most `workers` threads; the i-th result (or the exception it raised) is for the i-th item."""
    if workers <= 1 or len(items) <= 1:
        results: list[T | BaseException] = []
        for item in items:
            try:
                results.append(fn(item))
            except Exception as exc:  # noqa: BLE001 -- returned in the item's slot, see the module docstring
                results.append(exc)
        return results
    futures = [_pool(workers).submit(fn, item) for item in items]
    out: list[T | BaseException] = []
    for future in futures:
        try:
            out.append(future.result())
        except Exception as exc:  # noqa: BLE001 -- see the module docstring
            out.append(exc)
    return out
