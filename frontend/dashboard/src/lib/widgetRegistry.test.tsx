import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { mockVideoStats } from "../data/mockVideoStats"
import { MemberThemeProvider } from "../theme/MemberThemeProvider"
import { deriveChannelContribution, deriveKpis } from "../features/analytics/utils/deriveAnalytics"
import { deriveInsights } from "../features/analytics/utils/deriveInsights"
import { ALL_WIDGET_TYPES, getWidgetDefinition, renderWidget, type DashboardWidgetData } from "./widgetRegistry"

const filteredStats = mockVideoStats
const data: DashboardWidgetData = {
  kpis: deriveKpis(filteredStats),
  contributions: deriveChannelContribution(filteredStats),
  filteredStats,
  insights: deriveInsights(filteredStats, "1d"),
  byDay: [{ label: "09-01", value: 100 }],
  byChannel: [{ label: "Channel A", value: 100 }],
  period: "1d",
  timeZone: "UTC",
}

describe("widgetRegistry", () => {
  it("registers exactly the six v1 widget types from the Phase 7 brief", () => {
    expect(ALL_WIDGET_TYPES.sort()).toEqual(
      ["kpi-summary", "growth-bar-chart", "contribution-ring", "ranking", "insights", "video-stats-table"].sort(),
    )
  })

  it.each(ALL_WIDGET_TYPES)("%s has a complete, non-empty definition", (type) => {
    const definition = getWidgetDefinition(type)
    expect(definition.type).toBe(type)
    expect(definition.title.length).toBeGreaterThan(0)
    expect(definition.description.length).toBeGreaterThan(0)
    expect(definition.sizeLimits.minW).toBeGreaterThan(0)
    expect(definition.sizeLimits.minH).toBeGreaterThan(0)
  })

  it.each(ALL_WIDGET_TYPES)("%s renders without crashing given real dashboard data", (type) => {
    expect(() => render(<MemberThemeProvider>{renderWidget(type, data)}</MemberThemeProvider>)).not.toThrow()
  })

  it("insights widget falls back to a placeholder message when there are no insights", () => {
    const { getByText } = render(
      <MemberThemeProvider>{renderWidget("insights", { ...data, insights: [] })}</MemberThemeProvider>,
    )
    expect(getByText(/not enough data yet/i)).toBeTruthy()
  })

  describe("GAP-2D: allowedHeights (canonical 0.5X/1X capability, evidence-backed by GAP-2C/GAP-2C1)", () => {
    it.each([
      ["kpi-summary", [0.5, 1]],
      ["growth-bar-chart", [1]],
      ["contribution-ring", [1]],
      ["ranking", [0.5, 1]],
      ["insights", [0.5, 1]],
      ["video-stats-table", [0.5, 1]],
    ] as const)("AC2/AC6: %s advertises exactly %j", (type, expected) => {
      expect(getWidgetDefinition(type).allowedHeights).toEqual(expected)
    })

    it("AC7: growth-bar-chart does not advertise 0.5X (confirmed FAIL in real-browser GAP-2C1 evidence)", () => {
      expect(getWidgetDefinition("growth-bar-chart").allowedHeights).not.toContain(0.5)
    })

    it("AC7: contribution-ring does not advertise 0.5X (confirmed FAIL in real-browser GAP-2C evidence)", () => {
      expect(getWidgetDefinition("contribution-ring").allowedHeights).not.toContain(0.5)
    })
  })
})
