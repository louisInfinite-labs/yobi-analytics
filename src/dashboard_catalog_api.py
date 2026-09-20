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
computes from stored snapshots (`metric` names its entry in that module's
metric table); an item with no computable metric must not be listed. The
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
    # Key into comparison_api.METRICS -- the computation that backs this item.
    metric: str
    # Source and computation, for maintainers (not sent to clients).
    description: str


COMPARISON_ITEMS: tuple[ComparisonItemDefinition, ...] = (
    ComparisonItemDefinition(
        comparison_item_id="daily-view-growth",
        label="Daily view growth",
        metric="daily_view_growth",
        description=(
            "Per report date: the sum, over the creator's tracked non-Cold videos that have a raw snapshot on both "
            "that date and the previous date, of view_count(date) - view_count(date - 1 day) "
            "(view_growth_analytics.calculate_growth, period 1d, status ok only)."
        ),
    ),
    ComparisonItemDefinition(
        comparison_item_id="total-views",
        label="Total views",
        metric="total_views",
        description=(
            "Per report date: the sum of view_count on that date over the same videos daily-view-growth uses "
            "(videos with a snapshot on both that date and the previous date), so the two items describe one "
            "consistent video set per date."
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
