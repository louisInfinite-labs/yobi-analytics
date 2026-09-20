import { describe, expect, it } from "vitest"
import { findInsertableRows } from "./dashboardInsertionRows"
import type { CanonicalLayout, DashboardWidget } from "../model/dashboardLayout"

function widget(overrides: Partial<DashboardWidget> = {}): DashboardWidget {
  return { widgetId: "w", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1, ...overrides }
}

describe("findInsertableRows", () => {
  it("returns no rows for an empty layout", () => {
    const layout: CanonicalLayout = { grid: { columns: 1, rows: 1 }, widgets: [] }
    expect(findInsertableRows(layout)).toEqual([])
  })

  it("groups unit 1x1 widgets by y and orders each row by x", () => {
    const a = widget({ widgetId: "a", x: 1, y: 0 })
    const b = widget({ widgetId: "b", x: 0, y: 0 })
    const layout: CanonicalLayout = { grid: { columns: 2, rows: 1 }, widgets: [a, b] }

    expect(findInsertableRows(layout)).toEqual([{ y: 0, widgets: [b, a] }])
  })

  it("returns rows sorted by y, one entry per distinct y", () => {
    const top = widget({ widgetId: "top", x: 0, y: 0 })
    const bottom = widget({ widgetId: "bottom", x: 0, y: 1 })
    const layout: CanonicalLayout = { grid: { columns: 1, rows: 2 }, widgets: [bottom, top] }

    expect(findInsertableRows(layout).map((row) => row.y)).toEqual([0, 1])
  })

  it("excludes a row containing a wider-than-1 widget entirely", () => {
    const wide = widget({ widgetId: "wide", x: 0, y: 0, width: 2 })
    const layout: CanonicalLayout = { grid: { columns: 2, rows: 1 }, widgets: [wide] }

    expect(findInsertableRows(layout)).toEqual([])
  })

  it("excludes a row containing a 0.5X widget entirely", () => {
    const half: DashboardWidget = { widgetId: "half", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 0.5 }
    const layout: CanonicalLayout = { grid: { columns: 1, rows: 1 }, widgets: [half] }

    expect(findInsertableRows(layout)).toEqual([])
  })

  it("keeps a clean row while excluding a different, non-uniform row", () => {
    const clean1 = widget({ widgetId: "clean1", x: 0, y: 0 })
    const clean2 = widget({ widgetId: "clean2", x: 1, y: 0 })
    const half: DashboardWidget = { widgetId: "half", widgetType: "kpi-summary", x: 0, y: 1, width: 1, height: 0.5 }
    const layout: CanonicalLayout = { grid: { columns: 2, rows: 2 }, widgets: [clean1, clean2, half] }

    expect(findInsertableRows(layout)).toEqual([{ y: 0, widgets: [clean1, clean2] }])
  })
})
