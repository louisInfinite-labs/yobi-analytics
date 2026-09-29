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


# Deterministic order = the order the Add UI lists them.
CHART_CATALOG: tuple[ChartDefinition, ...] = (
    ChartDefinition("kpi-summary", "KPI Summary"),
    ChartDefinition("growth-bar-chart", "Growth Bar Chart"),
    ChartDefinition("contribution-ring", "Channel Contribution"),
    ChartDefinition("ranking", "Rankings"),
)


def get_chart_catalog(_query: dict[str, Any] | None = None) -> dict[str, Any]:
    """`GET /dashboard/chart-catalog`: every addable chart, in catalog order."""
    return {"charts": [{"chartDefinitionId": chart.chart_definition_id, "title": chart.title} for chart in CHART_CATALOG]}


def get_topics(_query: dict[str, Any] | None = None) -> dict[str, Any]:
    """`GET /topics`: the canonical video topic filter list, fixed and in display order."""
    return {"topics": [{"id": topic.id, "label": topic.label} for topic in TOPICS]}
