"""Emergency-stop Lambda: reference copy of the code deployed inline via the
AWS Console as `yobi-analytics-emergency-stop`'s `lambda_function.py`.

Not part of the main deployment package (scripts/package_lambda.py) — this
function has no dependency on src/ or requirements.txt, only the boto3
already bundled with the Lambda Python runtime. Kept here purely so the
handler logic is versioned in the repo; the live function's actual source is
whatever was last pasted into the Lambda console (see
docs/2026-09-05-emergency-stop-mechanism.md for the deployment steps).

Triggered by a message on the `yobi-analytics-emergency-stop-topic` SNS
topic, which Budget Action forwards to for spend >= 100% ($5) of
yobi-analytics-monthly.
"""

import boto3

TARGET_FUNCTION = "yobi-analytics-api"


def lambda_handler(event, context):
    """Set TARGET_FUNCTION's reserved concurrency to 0, blocking all invocations until a human restores it."""
    client = boto3.client("lambda")
    client.put_function_concurrency(
        FunctionName=TARGET_FUNCTION,
        ReservedConcurrentExecutions=0,
    )
    print(f"Emergency stop triggered: set {TARGET_FUNCTION} reserved concurrency to 0")
    return {"status": "stopped", "function": TARGET_FUNCTION}
