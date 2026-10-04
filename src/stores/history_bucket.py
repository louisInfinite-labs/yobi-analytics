"""Single source of truth for the S3 history bucket the READ side (the API Lambda) serves from.

The bucket name is fixed by design (terraform/history.tf creates exactly `yobi-analytics-history`, and the shared
Lambda role already grants access to it), so the API Lambda does not need an environment variable to find it.
YOBI_HISTORY_BUCKET therefore stays an OPTIONAL OVERRIDE: tests (moto), staging or a one-off environment can point
the read path elsewhere, while production simply omits it.

Deliberately NOT used by the write side (collector, history worker, ranking reducer, manifest/history stores,
backfill scripts). Those keep requiring an explicit YOBI_HISTORY_BUCKET -- Terraform sets it for the three data
Lambdas -- so a local run or a misconfigured Lambda can never silently write to the production bucket.
"""

from __future__ import annotations

import os

HISTORY_BUCKET_ENV_VAR = "YOBI_HISTORY_BUCKET"
DEFAULT_HISTORY_BUCKET = "yobi-analytics-history"


def resolve_history_bucket() -> str:
    """Return YOBI_HISTORY_BUCKET when set to a non-blank value, else the fixed default bucket.

    An empty or whitespace-only value counts as unset (the repository's convention everywhere else is
    `if not os.environ.get(...)`), so a blank override can never produce an invalid bucket name.
    """
    override = (os.environ.get(HISTORY_BUCKET_ENV_VAR) or "").strip()
    return override or DEFAULT_HISTORY_BUCKET
