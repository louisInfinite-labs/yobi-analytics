import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { mockVideoStats } from "../data/mockVideoStats"
import { MemberThemeProvider } from "../theme/MemberThemeProvider"
import { deriveChannelContribution, deriveKpis } from "./deriveAnalytics"
import { deriveInsights } from "./deriveInsights"
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
})
