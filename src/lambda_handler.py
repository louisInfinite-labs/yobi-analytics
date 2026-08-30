"""AWS Lambda entry point: wraps the local CLI collector for scheduled/manual invocation."""

from __future__ import annotations

from typing import Any

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
