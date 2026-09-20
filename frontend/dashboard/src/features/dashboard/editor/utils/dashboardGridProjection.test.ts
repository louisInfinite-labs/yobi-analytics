import type { WidgetTypeId } from "../model/widget"
import { describe, expect, it } from "vitest"
import { PROJECTION_UPDATED_AT, projectCanonicalLayoutForGridStack, projectResponsiveLayoutForGridStack } from "./dashboardGridProjection"
import { reflowLayoutForBreakpoint } from "./dashboardResponsive"
import { getWidgetDefinition } from "./widgetRegistry"
import type { CanonicalLayout, DashboardWidget } from "../model/dashboardLayout"

function widget(overrides: Partial<DashboardWidget> = {}): DashboardWidget {
  return { widgetId: "widget-a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1, ...overrides }
}

function layout(overrides: Partial<CanonicalLayout> = {}): CanonicalLayout {
  return { grid: { columns: 2, rows: 2 }, widgets: [], ...overrides }
}

describe("projectCanonicalLayoutForGridStack", () => {
  it("projects widgetId to instanceId and widgetType to type", () => {
    const result = projectCanonicalLayoutForGridStack(layout({ widgets: [widget({ widgetId: "w1", widgetType: "ranking" })] }))

    expect(result.widgets).toHaveLength(1)
    expect(result.widgets[0].instanceId).toBe("w1")
    expect(result.widgets[0].type).toBe("ranking")
  })

  it("passes the grid's column count through unchanged", () => {
    const result = projectCanonicalLayoutForGridStack(layout({ grid: { columns: 3, rows: 2 } }))
    expect(result.columns).toBe(3)
  })

  it("translates geometry via the GAP-4A adapter's row scale (1X -> 2 GridStack rows)", () => {
    const result = projectCanonicalLayoutForGridStack(layout({ widgets: [widget({ x: 1, y: 1, width: 1, height: 1 })] }))
    expect(result.widgets[0]).toMatchObject({ x: 1, y: 2, w: 1, h: 2 })
  })

  it("translates a 0.5X widget to 1 GridStack row", () => {
    const result = projectCanonicalLayoutForGridStack(layout({ widgets: [widget({ y: 0.5, height: 0.5 })] }))
    expect(result.widgets[0]).toMatchObject({ y: 1, h: 1 })
  })

  it("sources schemaVersion and settings from the real widget registry, not fabricated values", () => {
    const result = projectCanonicalLayoutForGridStack(layout({ widgets: [widget({ widgetType: "growth-bar-chart" })] }))
    const definition = getWidgetDefinition("growth-bar-chart")

    expect(result.widgets[0].schemaVersion).toBe(definition.schemaVersion)
    expect(result.widgets[0].settings).toBe(definition.defaultSettings)
  })

  it("uses a fixed, deterministic updatedAt sentinel", () => {
    const result = projectCanonicalLayoutForGridStack(layout({ widgets: [widget()] }))
    expect(result.widgets[0].updatedAt).toBe(PROJECTION_UPDATED_AT)
  })

  it("is deterministic: identical input produces a deep-equal result on repeated calls", () => {
    const input = layout({ widgets: [widget({ widgetId: "a" }), widget({ widgetId: "b", x: 1 })] })
    expect(projectCanonicalLayoutForGridStack(input)).toEqual(projectCanonicalLayoutForGridStack(input))
  })

  it("excludes a widget with an unregistered widgetType instead of throwing or fabricating a definition", () => {
    const result = projectCanonicalLayoutForGridStack(
      layout({
        widgets: [
          widget({ widgetId: "known", widgetType: "kpi-summary" }),
          widget({ widgetId: "retired", widgetType: "retired-widget-type", x: 1 }),
        ],
      }),
    )

    expect(result.widgets.map((w) => w.instanceId)).toEqual(["known"])
    expect(result.unrenderableWidgetIds).toEqual(["retired"])
  })

  it("GAP-9: projects a comparison widget under its own type instead of excluding it, keeping its canonical geometry", () => {
    const result = projectCanonicalLayoutForGridStack(
      layout({ widgets: [widget({ widgetId: "known" }), widget({ widgetId: "comparison", widgetType: "creator-comparison-chart", x: 1 })] }),
    )

    expect(result.widgets.map((w) => [w.instanceId, w.type])).toEqual([
      ["known", "kpi-summary"],
      ["comparison", "creator-comparison-chart"],
    ])
    expect(result.unrenderableWidgetIds).toEqual([])
    expect(result.widgets[1].x).toBe(1)
  })

  it("never mutates the input layout", () => {
    const input = layout({ widgets: [widget()] })
    const snapshot = JSON.parse(JSON.stringify(input))
    projectCanonicalLayoutForGridStack(input)
    expect(input).toEqual(snapshot)
  })

  it("produces a type that resolves real sizeLimits via the existing registry lookup DashboardGrid already uses", () => {
    const result = projectCanonicalLayoutForGridStack(layout({ widgets: [widget({ widgetType: "video-stats-table" })] }))
    const { sizeLimits } = getWidgetDefinition(result.widgets[0].type as WidgetTypeId)
    expect(sizeLimits.minW).toBeGreaterThan(0)
    expect(sizeLimits.minH).toBeGreaterThan(0)
  })
})

describe("projectResponsiveLayoutForGridStack (GAP-5B)", () => {
  it("projects a reflowed mobile stack using the reflow's own columns/widgets, identically to the canonical entry point's per-widget mapping", () => {
    const base = layout({
      grid: { columns: 2, rows: 2 },
      widgets: [
        widget({ widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0 }),
        widget({ widgetId: "b", widgetType: "ranking", x: 1, y: 0 }),
        widget({ widgetId: "c", widgetType: "contribution-ring", x: 0, y: 1 }),
        widget({ widgetId: "d", widgetType: "insights", x: 1, y: 1 }),
      ],
    })
    const responsive = reflowLayoutForBreakpoint(base, "mobile")
    const result = projectResponsiveLayoutForGridStack(responsive)

    expect(result.columns).toBe(1)
    expect(result.widgets).toHaveLength(4)
    expect(result.widgets.map((w) => w.instanceId).sort()).toEqual(["a", "b", "c", "d"])
    // Every widget lands in the single reflowed column.
    expect(new Set(result.widgets.map((w) => w.x))).toEqual(new Set([0]))
  })

  it("excludes an unrenderable widgetType from a reflowed layout the same way the canonical entry point does", () => {
    const base = layout({ widgets: [widget({ widgetId: "known" }), widget({ widgetId: "retired", widgetType: "retired-widget-type", x: 1 })] })
    const responsive = reflowLayoutForBreakpoint(base, "mobile")
    const result = projectResponsiveLayoutForGridStack(responsive)

    expect(result.widgets.map((w) => w.instanceId)).toEqual(["known"])
    expect(result.unrenderableWidgetIds).toEqual(["retired"])
  })

  it("never mutates the input responsive layout", () => {
    const base = layout({ widgets: [widget()] })
    const responsive = reflowLayoutForBreakpoint(base, "tablet")
    const snapshot = JSON.parse(JSON.stringify(responsive))
    projectResponsiveLayoutForGridStack(responsive)
    expect(responsive).toEqual(snapshot)
  })
})
