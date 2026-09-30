import { describe, expect, it } from "vitest"
import { resolveAddableWidgetTypes } from "./dashboardChartCatalogOptions"
import type { ChartCatalogItem } from "../model/dashboardChartCatalog"

describe("resolveAddableWidgetTypes", () => {
  it("returns an empty list for an empty catalog (AC6 empty-success)", () => {
    expect(resolveAddableWidgetTypes([])).toEqual([])
  })

  it("includes a returned, frontend-supported chart definition (AC3)", () => {
    const items: ChartCatalogItem[] = [{ chartDefinitionId: "subscriber-leaderboard", title: "Subscriber Leaderboard" }]
    expect(resolveAddableWidgetTypes(items)).toEqual(["subscriber-leaderboard"])
  })

  it("excludes a catalog item whose chartDefinitionId is not a known widget type (AC2/AC4)", () => {
    const items: ChartCatalogItem[] = [
      { chartDefinitionId: "subscriber-leaderboard", title: "Subscriber Leaderboard" },
      { chartDefinitionId: "future-chart-not-yet-supported", title: "Future Chart" },
    ]
    expect(resolveAddableWidgetTypes(items)).toEqual(["subscriber-leaderboard"])
  })

  it("preserves catalog order", () => {
    const items: ChartCatalogItem[] = [
      { chartDefinitionId: "creator-video-ranking", title: "Creator Video Ranking" },
      { chartDefinitionId: "subscriber-leaderboard", title: "Subscriber Leaderboard" },
    ]
    expect(resolveAddableWidgetTypes(items)).toEqual(["creator-video-ranking", "subscriber-leaderboard"])
  })

  it("collapses a duplicate chartDefinitionId to one option", () => {
    const items: ChartCatalogItem[] = [
      { chartDefinitionId: "subscriber-leaderboard", title: "Subscriber Leaderboard" },
      { chartDefinitionId: "subscriber-leaderboard", title: "Subscriber Leaderboard (duplicate)" },
    ]
    expect(resolveAddableWidgetTypes(items)).toEqual(["subscriber-leaderboard"])
  })
})
