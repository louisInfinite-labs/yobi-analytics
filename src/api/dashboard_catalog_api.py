"""Dashboard catalog definitions: the backend-owned source of
truth for (a) which charts the Dashboard's Add UI may offer and (b) which
comparison items a creator comparison may chart.

Pure, storage-free request handling in the same style as read_api.py /
heartbeat_api.py: `api_handler.py` routes to it. Both lists are fixed,
ordered tuples, so every response is deterministic and every ID is stable.

Chart catalog: `chartDefinitionId` is also the frontend's widget type id (the
frontend renders a catalog entry only when it has a registered widget of that
id, so an entry it cannot render is simply not offered). Only ordinary
addable charts belong here -- comparison items are a different concept and
are never listed as charts.

Comparison items: each item maps to a metric `comparison_api.py` really
serves from stored per-creator aggregates (`metric` names its entry in that
module's metric table); an item with no stored source must not be listed. The
description records the source and computation.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


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


@dataclass(frozen=True)
class ComparisonItemDefinition:
    comparison_item_id: str
    label: str
    # Key into comparison_api.METRICS -- the stored aggregate that backs this item.
    metric: str
    # Source and computation, for maintainers (not sent to clients).
    description: str


COMPARISON_ITEMS: tuple[ComparisonItemDefinition, ...] = (
    ComparisonItemDefinition(
        comparison_item_id="daily-view-growth",
        label="Daily view growth",
        metric="daily_view_growth",
        description=(
            "Per report date: the creator's stored 1d creatorSummary `viewSum` -- the sum of every eligible video's "
            "exact gain against the previous day (history_ranking.creator_period_partials)."
        ),
    ),
    ComparisonItemDefinition(
        comparison_item_id="total-views",
        label="Total views",
        metric="total_views",
        description=(
            "Per report date: the creator's stored all-period creatorSummary `viewSum` -- the sum of every video's "
            "latest collected view count (history_ranking.creator_period_partials)."
        ),
    ),
)


def get_chart_catalog(_query: dict[str, Any] | None = None) -> dict[str, Any]:
    """`GET /dashboard/chart-catalog`: every addable chart, in catalog order."""
    return {"charts": [{"chartDefinitionId": chart.chart_definition_id, "title": chart.title} for chart in CHART_CATALOG]}


def get_comparison_items(_query: dict[str, Any] | None = None) -> dict[str, Any]:
    """`GET /dashboard/comparison-items`: every supported comparison item, in definition order."""
    return {
        "comparisonItems": [
            {"comparisonItemId": item.comparison_item_id, "label": item.label} for item in COMPARISON_ITEMS
        ]
    }
