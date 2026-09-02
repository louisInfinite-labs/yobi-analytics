"""AWS Lambda entry point: wraps the local CLI collector for scheduled/manual invocation."""

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

from main import main


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Run the daily collection job and report success/failure to Lambda.

    Raises on a non-zero exit code so AWS Lambda's own invocation-error
    metrics (and any future EventBridge/CloudWatch alarms, Roadmap 2.4/2.5)
    reflect a failed run, rather than the job printing an error to stdout
    and still being counted as a successful invocation.
    """
    exit_code = main()
    if exit_code != 0:
        raise RuntimeError(f"Collection job failed (exit code {exit_code}); see the log above for details.")
    return {"statusCode": 200}
