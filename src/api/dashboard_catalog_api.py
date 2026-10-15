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

from tracking.video_topics import current_taxonomy


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


def get_topics(_query: dict[str, Any] | None = None) -> dict[str, Any]:
    """`GET /topics`: the canonical video topic filter list -- the approved Topic Catalog (DynamoDB table YobiTopicCatalog, partition
    GLOBAL) in its own display order, read through tracking.video_topics' cached, fail-safe taxonomy so that this response, topic
    validation and classification can never disagree about which topics exist. Never a YobiVideoMaster scan and never the REVIEW
    partition.

    `labels` is every topic's zh-TW/en/ja display text -- the frontend's only source for it, so a topic added to the catalog needs no
    frontend code change. `label` is additive, backward-compat-only: `/topics` is a real, deployed, unauthenticated API Gateway route
    (no authorizer or API key -- terraform/api_gateway.tf) that this repo has no visibility into every caller of, so this field
    (the record's `legacy_label`, else its English label, else its id) is never removed.

    `searchAliases` is every backend-owned literal synonym for the topic beyond its own id/labels -- the frontend's Video Search
    downloads this SAME catalog once and resolves a user's free-text query to topic ids locally against it. Always a list."""
    return {
        "topics": [
            {
                "id": topic.id,
                "label": topic.legacy_label or topic.labels.get("en") or topic.id,
                "labels": dict(topic.labels),
                "searchAliases": list(topic.search_aliases),
            }
            for topic in current_taxonomy().topics
        ]
    }
