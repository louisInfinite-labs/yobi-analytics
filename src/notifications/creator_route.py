"""The in-app route a push notification opens: the Creator Home of the creator the notification is about.

The frontend's `/creator/:slug` URL (frontend/dashboard/src/app/navigation/creatorRoutes.ts) is the canonical creatorId with "_" written as "-"
(`aizawa_ema` -> `/creator/aizawa-ema`). Creator Home already shows that creator's live stream, else the upcoming one, else the latest completed
one, so the route alone is enough -- no videoId or extra request is needed, and an ended or unavailable stream still lands on a valid page.

The route is attached to a push payload as `data.url`, which the service worker (frontend/dashboard/public/sw.js) accepts only when it is a
same-origin path. This module only ever produces a relative `/creator/<slug>` path for a creator that exists and is active in Creator Master;
for anything else it produces nothing, and the notification keeps today's behaviour (the tap opens or focuses the app at `/`).
"""

from __future__ import annotations

import re
from typing import Any

CREATOR_ROUTE_PREFIX = "/creator/"

# The canonical creatorId shape the frontend slug mapping relies on: lowercase [a-z0-9] segments joined by single underscores.
_CANONICAL_CREATOR_ID = re.compile(r"[a-z0-9]+(?:_[a-z0-9]+)*")


def creator_route(creator_id: Any, creators_by_id: dict[str, Any]) -> str | None:
    """The `/creator/<slug>` path for an active, known creator with a canonical id, else None."""
    if not isinstance(creator_id, str) or not _CANONICAL_CREATOR_ID.fullmatch(creator_id):
        return None
    creator = creators_by_id.get(creator_id)
    if creator is None or not creator.active:
        return None
    return CREATOR_ROUTE_PREFIX + creator_id.replace("_", "-")


def with_creator_route(data: dict[str, Any], creator_id: Any, creators_by_id: dict[str, Any]) -> dict[str, Any]:
    """`data` plus `url` (the creator's route) when one is valid; `data` itself is never mutated and its own fields are kept as they are."""
    route = creator_route(creator_id, creators_by_id)
    return {**data, "url": route} if route else dict(data)
