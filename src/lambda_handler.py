"""AWS Lambda entry point: wraps the local CLI collector for scheduled/manual invocation.

Also dispatches two further, separately-scheduled triggers (2026-09-05), both
invoking this same function/Lambda with a distinguishing `mode` in the
event rather than deploying separate functions:

- `{"mode": "discovery_only"}` -> main.run_discovery(): finds and persists
  new videos only, no statistics collection. Intended for a JST 00:00
  EventBridge rule, so a new video's notification can fire hours earlier
  than waiting for the heavier 18:00 run to also handle discovery.
- `{"mode": "precompute_trending"}` -> trending_precompute.run(): populates
  YobiTrendingCache. Intended for a later-hour EventBridge rule so its own
  DynamoDB read/CPU work never stacks directly on top of either collection
  run's own time/memory budget.

See docs/aws-setup.zh-TW.md for the actual configured schedule.
"""

from __future__ import annotations

import os
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

# json_store.DATA_DIR is read once at import time, so this must run before
# `from main import main`. Lambda's deployment package directory (/var/task)
# is read-only; YOBI_DATA_DIR is normally set explicitly on the function's
# configuration (see docs/aws-setup), but this defensive default prevents a
# silent PermissionError on a fresh deployment where that step was missed.
# setdefault preserves an explicitly configured value. AWS_LAMBDA_FUNCTION_NAME
# is set by the Lambda runtime itself, so this never fires for local dev.
if os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
    os.environ.setdefault("YOBI_DATA_DIR", "/tmp")

from main import main, run_discovery

# Matches main.py's own collection-timezone convention: a JST calendar date,
# not the server's local/UTC clock.
_PRECOMPUTE_TIMEZONE = ZoneInfo("Asia/Tokyo")


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Dispatch on `event["mode"]`: the daily collection job (default), a discovery-only
    run (`mode: discovery_only`, JST 00:00), or trending_precompute.run() (`mode: precompute_trending`).

    Raises on failure in every mode so AWS Lambda's own invocation-error
    metrics (and any future EventBridge/CloudWatch alarms, Roadmap 2.4/2.5)
    reflect a failed run, rather than the job printing an error to stdout
    and still being counted as a successful invocation.
    """
    mode = (event or {}).get("mode")

    if mode == "precompute_trending":
        return _run_trending_precompute((event or {}).get("period"))

    if mode == "discovery_only":
        exit_code = run_discovery()
        if exit_code != 0:
            raise RuntimeError(f"Discovery-only job failed (exit code {exit_code}); see the log above for details.")
        return {"statusCode": 200}

    exit_code = main()
    if exit_code != 0:
        raise RuntimeError(f"Collection job failed (exit code {exit_code}); see the log above for details.")
    return {"statusCode": 200}


def _run_trending_precompute(period: str | None) -> dict[str, Any]:
    """Populate YobiTrendingCache for today so read_api.py's public trending routes serve a cache hit.

    `period`: one of "1d"/"7d"/"30d" to precompute just that period (each of
    the three EventBridge schedules passes its own — see trending_precompute.
    run's own docstring for why running all three in one invocation doesn't
    fit this Lambda's budget), or None to run every period in one call
    (kept for local/manual testing convenience, not used by any schedule).

    Imported lazily (not at module load time) since this path — and its
    dynamodb_store/read_api dependencies — is only ever exercised when
    YOBI_STORAGE_BACKEND=dynamodb is already set, i.e. once actually
    deployed; local/manual invocation of the default collection path never
    imports it.
    """
    import trending_precompute

    report_date = datetime.now(_PRECOMPUTE_TIMEZONE).date()
    periods = (period,) if period else trending_precompute._PERIODS
    stats = trending_precompute.run(report_date, periods=periods)
    if stats["scopes_written"] == 0 and stats["scopes_failed"] > 0:
        raise RuntimeError(f"Trending precompute failed for every scope; see the log above for details. {stats}")
    if stats["scopes_failed"] > 0:
        print(f"Warning: trending precompute finished with {stats['scopes_failed']} failed scope(s): {stats}")
    return {"statusCode": 200, "body": stats}
