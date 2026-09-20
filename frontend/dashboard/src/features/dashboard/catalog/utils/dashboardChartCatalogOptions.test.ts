import { describe, expect, it } from "vitest"
import { resolveAddableWidgetTypes } from "./dashboardChartCatalogOptions"
import type { ChartCatalogItem } from "../model/dashboardChartCatalog"

describe("resolveAddableWidgetTypes", () => {
  it("returns an empty list for an empty catalog (AC6 empty-success)", () => {
    expect(resolveAddableWidgetTypes([])).toEqual([])
  })

  it("includes a returned, frontend-supported chart definition (AC3)", () => {
    const items: ChartCatalogItem[] = [{ chartDefinitionId: "kpi-summary", title: "KPI Summary" }]
    expect(resolveAddableWidgetTypes(items)).toEqual(["kpi-summary"])
  })

  it("excludes a catalog item whose chartDefinitionId is not a known widget type (AC2/AC4)", () => {
    const items: ChartCatalogItem[] = [
      { chartDefinitionId: "kpi-summary", title: "KPI Summary" },
      { chartDefinitionId: "future-chart-not-yet-supported", title: "Future Chart" },
    ]
    expect(resolveAddableWidgetTypes(items)).toEqual(["kpi-summary"])
  })

  it("preserves catalog order", () => {
    const items: ChartCatalogItem[] = [
      { chartDefinitionId: "ranking", title: "Ranking" },
      { chartDefinitionId: "kpi-summary", title: "KPI Summary" },
    ]
    expect(resolveAddableWidgetTypes(items)).toEqual(["ranking", "kpi-summary"])
  })

  it("collapses a duplicate chartDefinitionId to one option", () => {
    const items: ChartCatalogItem[] = [
      { chartDefinitionId: "kpi-summary", title: "KPI Summary" },
      { chartDefinitionId: "kpi-summary", title: "KPI Summary (duplicate)" },
    ]
    expect(resolveAddableWidgetTypes(items)).toEqual(["kpi-summary"])
  })
})
