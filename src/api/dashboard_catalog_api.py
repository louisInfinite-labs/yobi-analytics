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

from stores.topic_catalog_store import query_global_topics


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
    """`GET /topics`: the canonical video topic filter list, read from the global Topic Catalog
    (DynamoDB table YobiTopicCatalog, via stores.topic_catalog_store) and returned in catalog
    display order -- never a YobiVideoMaster scan and never tracking.video_topics.TOPICS directly
    (that tuple remains the classifier's own match-pattern source and the seed script's input, but
    GET /topics' response now comes from the catalog those entries were seeded into).

    `labels` is every topic's zh-TW/en/ja display text -- the frontend's only source for it, so a
    new topic needs no frontend code change to render correctly in any locale. `label` is additive,
    backward-compat-only: `/topics` is a real, deployed, unauthenticated API Gateway route (no
    authorizer or API key -- terraform/api_gateway.tf) that this repo has no visibility into every
    caller of, so this field, byte-identical to what this endpoint returned before `labels` existed,
    is never removed. A catalog item with no stored `legacy_label` (any topic added after `labels`
    existed) falls back to its own English label, or its id if even that's missing.

    `searchAliases` is every real, backend-owned literal synonym for this topic beyond its own
    id/labels -- the frontend's Video Search feature downloads this SAME catalog once and resolves a
    user's free-text query to canonical topic ids locally against it, rather than the backend
    re-deriving that mapping per Search request. Always a list, empty when a topic has no alias
    beyond its own id/labels.
    """
    items = sorted(query_global_topics(), key=lambda item: item["display_order"])
    return {
        "topics": [
            {
                "id": item["topic_tag"],
                "label": item.get("legacy_label") or item.get("topic_en") or item["topic_tag"],
                "labels": {"zh-TW": item["topic_zh"], "en": item["topic_en"], "ja": item["topic_ja"]},
                "searchAliases": list(item.get("search_aliases") or []),
            }
            for item in items
        ]
    }
