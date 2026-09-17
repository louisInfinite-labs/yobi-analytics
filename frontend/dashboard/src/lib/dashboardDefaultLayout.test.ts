import { describe, expect, it } from "vitest"
import { buildDefaultLayout, DEFAULT_WIDGET_CONFIG, resolveInitialLayout } from "./dashboardDefaultLayout"
import { validateLayout } from "./dashboardLayoutValidation"
import type { CanonicalLayout } from "../types/dashboardLayout"

describe("buildDefaultLayout", () => {
  it("produces exactly two columns and two rows", () => {
    const layout = buildDefaultLayout()
    expect(layout.grid).toEqual({ columns: 2, rows: 2 })
  })

  it("matches the explicit default widget count, types, and order", () => {
    const layout = buildDefaultLayout()
    expect(layout.widgets.map((w) => w.widgetType)).toEqual(DEFAULT_WIDGET_CONFIG.map((c) => c.widgetType))
    expect(layout.widgets).toHaveLength(DEFAULT_WIDGET_CONFIG.length)
  })

  it("gives every default widget a unique widgetId", () => {
    const layout = buildDefaultLayout()
    const ids = layout.widgets.map((w) => w.widgetId)
    expect(ids.every((id) => id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("produces a layout that passes the same validation as user-added widgets", () => {
    const result = validateLayout(buildDefaultLayout())
    expect(result).toEqual({ valid: true, errors: [] })
  })

  it("builds a fresh set of widgetIds on every call", () => {
    const a = buildDefaultLayout()
    const b = buildDefaultLayout()
    expect(a.widgets.map((w) => w.widgetId)).not.toEqual(b.widgets.map((w) => w.widgetId))
  })
})

describe("resolveInitialLayout", () => {
  it("returns the 2x2 default when there is no saved layout", () => {
    const layout = resolveInitialLayout(null)
    expect(layout.grid).toEqual({ columns: 2, rows: 2 })
    expect(layout.widgets).toHaveLength(DEFAULT_WIDGET_CONFIG.length)
  })

  it("does not overwrite a valid saved 3x2 layout with the default", () => {
    const saved: CanonicalLayout = {
      grid: { columns: 3, rows: 2 },
      widgets: [
        { widgetId: "saved-a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
        { widgetId: "saved-b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
        { widgetId: "saved-c", widgetType: "insights", x: 2, y: 0, width: 1, height: 1 },
      ],
    }

    const layout = resolveInitialLayout(saved)

    expect(layout.grid).toEqual({ columns: 3, rows: 2 })
    expect(layout).toBe(saved)
  })

  it("preserves identical widgetIds, coordinates, sizes, and order through a reload round trip", () => {
    const saved: CanonicalLayout = {
      grid: { columns: 3, rows: 2 },
      widgets: [
        { widgetId: "saved-a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
        { widgetId: "saved-b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
        { widgetId: "saved-c", widgetType: "insights", x: 2, y: 0, width: 1, height: 1 },
      ],
    }

    const beforeReload = resolveInitialLayout(saved)
    const reloaded: CanonicalLayout = JSON.parse(JSON.stringify(beforeReload))
    const afterReload = resolveInitialLayout(reloaded)

    expect(afterReload).toEqual(beforeReload)
    expect(afterReload.widgets.map((w) => w.widgetId)).toEqual(beforeReload.widgets.map((w) => w.widgetId))
  })
})
