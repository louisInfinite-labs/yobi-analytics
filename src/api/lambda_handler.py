"""AWS Lambda entry point: wraps the local CLI collector for scheduled/manual invocation.

Also dispatches a further, separately-scheduled trigger (2026-09-05),
invoking this same function/Lambda with a distinguishing `mode` in the
event rather than deploying a separate function:

- `{"mode": "discovery_only"}` -> main.run_discovery(): finds and persists
  new videos only, no statistics collection. Intended for a JST 00:00
  EventBridge rule, so a new video's notification can fire hours earlier
  than waiting for the heavier 18:00 run to also handle discovery.

R7 (AWS Cost Recovery): `{"mode": "precompute_trending"}` and its
`trending_precompute.run()` were removed here -- both its own EventBridge
schedules were already Terraform-disabled (the daily_history Step Functions
pipeline's own ranking_reducer.py had already fully superseded it as
YobiTrendingCache's real production writer) and its own module docstring
already declared it retired.

R7 safety correction: an explicit but unrecognized `mode` (a retired value
like "precompute_trending" reaching this Lambda from a stale EventBridge
target, a manual retry, or a leftover script) must never silently fall
through to the default collection job below -- that would mean a request to
do nothing (or something else entirely) instead quietly runs a full
YouTube-statistics collection run. `mode is None` (the field omitted
entirely) is the one case that legitimately means "run the default job";
any other value not in `_VALID_MODES` raises UnsupportedModeError instead,
following this codebase's own existing convention for an unsupported enum
value (analytics.view_growth_analytics.comparison_date's InvalidPeriodError):
raise a named ValueError subclass rather than silently coercing or defaulting.

See docs/aws-setup.zh-TW.md for the actual configured schedule.
"""

from __future__ import annotations

import os
from typing import Any

# json_store.DATA_DIR is read once at import time, so this must run before
# `from main import main`. Lambda's deployment package directory (/var/task)
# is read-only; YOBI_DATA_DIR is normally set explicitly on the function's
# configuration (see docs/aws-setup), but this defensive default prevents a
# silent PermissionError on a fresh deployment where that step was missed.
# setdefault preserves an explicitly configured value. AWS_LAMBDA_FUNCTION_NAME
# is set by the Lambda runtime itself, so this never fires for local dev.
if os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
    os.environ.setdefault("YOBI_DATA_DIR", "/tmp")

from collection.main import main, run_discovery

# The only explicit `mode` value this Lambda still recognizes. `mode` absent
# entirely (None) is handled separately below (falls through to the default
# collection job) -- it is not itself a member of this set.
_VALID_MODES = frozenset({"discovery_only"})


class UnsupportedModeError(ValueError):
    """Raised when an event's own explicit `mode` field names a value this
    Lambda no longer recognizes (e.g. the retired "precompute_trending").
    Deliberately never caught here -- an unrecognized mode is a caller bug
    (a stale schedule target, a manual retry using an old event shape, a
    leftover script) that must surface as a failed Lambda invocation, the
    same as any other error this handler raises.
    """


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Dispatch on `event["mode"]`: the daily collection job (default, when
    `mode` is omitted), or a discovery-only run (`mode: discovery_only`,
    JST 00:00). Any other explicit `mode` raises UnsupportedModeError before
    either job ever runs -- see this module's own docstring.

    Raises on failure in every mode so AWS Lambda's own invocation-error
    metrics (and any future EventBridge/CloudWatch alarms, Roadmap 2.4/2.5)
    reflect a failed run, rather than the job printing an error to stdout
    and still being counted as a successful invocation.
    """
    mode = (event or {}).get("mode")

    if mode is not None and mode not in _VALID_MODES:
        raise UnsupportedModeError(f"Unsupported mode {mode!r}; expected one of {sorted(_VALID_MODES)} or omitted")

    if mode == "discovery_only":
        exit_code = run_discovery()
        if exit_code != 0:
            raise RuntimeError(f"Discovery-only job failed (exit code {exit_code}); see the log above for details.")
        return {"statusCode": 200}

    exit_code = main()
    if exit_code != 0:
        raise RuntimeError(f"Collection job failed (exit code {exit_code}); see the log above for details.")
    return {"statusCode": 200}
