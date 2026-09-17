import { describe, expect, it } from "vitest"
import { computeRowInsertionPreview } from "./dashboardInsertionPreview"
import { validateLayout } from "./dashboardLayoutValidation"
import type { CanonicalLayout, DashboardWidget } from "../types/dashboardLayout"

const A: DashboardWidget = { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 }
const B: DashboardWidget = { widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 }
const BASE: CanonicalLayout = { grid: { columns: 2, rows: 1 }, widgets: [A, B] }
const CANDIDATE = { widgetId: "e", widgetType: "insights" }

describe("computeRowInsertionPreview", () => {
  it("given A|B, inserting at the middle slot previews A|E|B (AC1)", () => {
    const preview = computeRowInsertionPreview(BASE, [A, B], CANDIDATE, 1)
    expect(preview.widgets.map((w) => w.widgetId)).toEqual(["a", "e", "b"])
    expect(preview.widgets.map((w) => w.x)).toEqual([0, 1, 2])
    expect(preview.grid.columns).toBe(3)
    expect(validateLayout(preview).valid).toBe(true)
  })

  it("given A|B, inserting at the right slot previews A|B|E (AC2)", () => {
    const preview = computeRowInsertionPreview(BASE, [A, B], CANDIDATE, 2)
    expect(preview.widgets.map((w) => w.widgetId)).toEqual(["a", "b", "e"])
    expect(preview.widgets.map((w) => w.x)).toEqual([0, 1, 2])
  })

  it("preserves the candidate's widgetId and widgetType exactly", () => {
    const preview = computeRowInsertionPreview(BASE, [A, B], CANDIDATE, 1)
    const inserted = preview.widgets.find((w) => w.widgetId === "e")
    expect(inserted?.widgetType).toBe("insights")
  })

  it("adjusts only the widgets in the target row, never reordering by anything but the requested slot", () => {
    const preview = computeRowInsertionPreview(BASE, [A, B], CANDIDATE, 0)
    expect(preview.widgets.map((w) => w.widgetId)).toEqual(["e", "a", "b"])
  })

  it("a slot that would exceed the supported 1x1-5x5 grid range is rejected by the canonical validator (AC8)", () => {
    const fiveWide: DashboardWidget[] = Array.from({ length: 5 }, (_, i) => ({
      widgetId: `w${i}`,
      widgetType: "kpi-summary",
      x: i,
      y: 0,
      width: 1,
      height: 1,
    }))
    const base: CanonicalLayout = { grid: { columns: 5, rows: 1 }, widgets: fiveWide }
    const preview = computeRowInsertionPreview(base, fiveWide, CANDIDATE, 2)

    expect(preview.grid.columns).toBe(6)
    const result = validateLayout(preview)
    expect(result.valid).toBe(false)
    expect(result.errors.map((e) => e.code)).toContain("INVALID_GRID_SIZE")
  })
})
