"""Transport for the Holodex v2 API (H2 of the Holodex backend integration).

This module only performs authenticated HTTP requests and hands back the
decoded JSON payload as-is — it does not decide which endpoint/params the
Live/Upcoming request path needs (src/api/read_api.py's route handler, H4,
owns that) and does not map the response into this project's own models
(H3 owns that). Every failure raises HolodexAPIError rather than returning
an empty result: silently returning [] here would make a temporary Holodex
outage indistinguishable from a genuine "nobody is live" result, and that
distinction belongs at the handler layer (H4), not this client.
"""

from __future__ import annotations

from typing import Any

import requests

from ops.config import get_holodex_api_key

HOLODEX_BASE_URL = "https://holodex.net/api/v2"

# Bounded so a slow/unresponsive Holodex response can't hang the caller (e.g.
# a Lambda invocation) indefinitely — same rationale and value as
# notifications/push_sender.py's _PUSH_REQUEST_TIMEOUT_SECONDS.
_HOLODEX_REQUEST_TIMEOUT_SECONDS = 10.0

# Module-level and reused across calls so a warm Lambda container keeps its
# connection pool, matching notifications/push_sender.py's _PUSH_SESSION.
_HOLODEX_SESSION = requests.Session()


class HolodexAPIError(RuntimeError):
    """Raised when a Holodex API request fails or returns unusable data.

    Always raised, never swallowed into an empty result — distinguishing a
    Holodex outage from a genuine empty Live/Upcoming result is the calling
    handler's job (H4), not this client's.
    """


def holodex_get(path: str, params: dict[str, str] | None = None) -> Any:
    """GET one Holodex v2 API path and return the decoded JSON payload as-is.

    Authenticates with the X-APIKEY header via get_holodex_api_key() —
    never a frontend VITE_ variable, and never an environment variable read
    directly by this module. `path` is joined onto HOLODEX_BASE_URL as-is
    (e.g. "/live", "/videos"). Returns whatever shape Holodex's response
    decodes to (a list for /live and /videos, per its documented API).
    """
    api_key = get_holodex_api_key()
    url = f"{HOLODEX_BASE_URL}{path}"
    try:
        response = _HOLODEX_SESSION.get(
            url,
            params=params,
            headers={"X-APIKEY": api_key},
            timeout=_HOLODEX_REQUEST_TIMEOUT_SECONDS,
        )
    except requests.Timeout as exc:
        raise HolodexAPIError(f"Holodex API request to {path!r} timed out: {exc}") from exc
    except requests.RequestException as exc:
        raise HolodexAPIError(f"Holodex API request to {path!r} failed: {exc}") from exc

    if not response.ok:
        raise HolodexAPIError(
            f"Holodex API request to {path!r} failed with status {response.status_code}: {response.text}"
        )

    try:
        return response.json()
    except ValueError as exc:
        raise HolodexAPIError(f"Holodex API returned a malformed (non-JSON) response for {path!r}: {exc}") from exc
