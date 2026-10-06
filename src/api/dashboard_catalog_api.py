"""Dashboard catalog definitions: the backend-owned source of truth for which
charts the Dashboard's Add UI may offer.

Pure, storage-free request handling in the same style as read_api.py /
heartbeat_api.py: `api_handler.py` routes to it. CHART_CATALOG is a fixed,
ordered tuple, so every response is deterministic and every ID is stable.

`chartDefinitionId` is also the frontend's widget type id (the frontend
renders a catalog entry only when it has a registered widget of that id, so
an entry it cannot render is simply not offered).

R8B (AWS Cost Recovery): the comparison-item catalog (GET /dashboard/
comparison-items) was removed here along with GET /dashboard/comparison-data
(comparison_api.py, deleted) and its creatorSummary producer -- R8A already
removed every production frontend consumer of both routes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from tracking.video_topics import TOPICS


@dataclass(frozen=True)
class ChartDefinition:
    chart_definition_id: str
    title: str


# R9 (org-trending retirement): the old cross-creator/org-wide widget set
# (kpi-summary/growth-bar-chart/contribution-ring/ranking/insights/
# video-stats-table) is retired along with GET /organizations/{organization}/
# trending, its only data source. The Dashboard's Add UI now offers only the
# two surviving ranking products.
#
# Deterministic order = the order the Add UI lists them.
CHART_CATALOG: tuple[ChartDefinition, ...] = (
    ChartDefinition("subscriber-leaderboard", "Subscriber Leaderboard"),
    ChartDefinition("creator-video-ranking", "Creator Video Ranking"),
)


def get_chart_catalog(_query: dict[str, Any] | None = None) -> dict[str, Any]:
    """`GET /dashboard/chart-catalog`: every addable chart, in catalog order."""
    return {"charts": [{"chartDefinitionId": chart.chart_definition_id, "title": chart.title} for chart in CHART_CATALOG]}


# Backward compatibility only: `GET /topics`' original single-string `label` field,
# byte-identical to what this endpoint returned before `labels` (per-locale text)
# existed. frontend/dashboard never reads this -- `labels` is its only source of
# topic display text, and this map must never become a second one.
#
# `/topics` is a real, deployed, unauthenticated API Gateway route (no authorizer
# or API key -- terraform/api_gateway.tf) that this repo has no visibility into
# every caller of, so removing `label` outright would be a real breaking risk
# rather than a safely-provable no-op. A topic added after `labels` existed (not
# one of the 8 below) has no historical `label` to preserve, so get_topics falls
# back to that topic's own English label, or its id if even that's missing.
_LEGACY_TOPIC_LABELS: dict[str, str] = {
    "valorant": "VALORANT",
    "sf6": "SF6",
    "apex": "APEX",
    "minecraft": "Minecraft",
    "singing": "Singing",
    "mv": "MV",
    "chatting": "Chatting",
    "other": "Other",
}


def get_topics(_query: dict[str, Any] | None = None) -> dict[str, Any]:
    """`GET /topics`: the canonical video topic filter list, fixed and in display
    order. `labels` is every topic's zh-TW/en/ja display text -- the frontend's
    only source for it, so a new topic needs no frontend code change to render
    correctly in any locale (see video_topics.Topic's own docstring). `label` is
    additive, backward-compat-only (see _LEGACY_TOPIC_LABELS above)."""
    return {
        "topics": [
            {
                "id": topic.id,
                "label": _LEGACY_TOPIC_LABELS.get(topic.id, topic.labels.get("en", topic.id)),
                "labels": dict(topic.labels),
            }
            for topic in TOPICS
        ]
    }
