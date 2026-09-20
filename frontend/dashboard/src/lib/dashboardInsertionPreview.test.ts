import { describe, expect, it } from "vitest"
import { computeRowInsertionPreview, computeValidatedRowInsertion } from "./dashboardInsertionPreview"
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

  it("GAP-2F: preserves an untouched second row unchanged when inserting into the first row", () => {
    const top1: DashboardWidget = { widgetId: "top1", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 }
    const top2: DashboardWidget = { widgetId: "top2", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 }
    const bottom1: DashboardWidget = { widgetId: "bottom1", widgetType: "contribution-ring", x: 0, y: 1, width: 1, height: 1 }
    const bottom2: DashboardWidget = { widgetId: "bottom2", widgetType: "insights", x: 1, y: 1, width: 1, height: 1 }
    const twoRowBase: CanonicalLayout = { grid: { columns: 2, rows: 2 }, widgets: [top1, top2, bottom1, bottom2] }

    const preview = computeRowInsertionPreview(twoRowBase, [top1, top2], CANDIDATE, 1)

    expect(preview.widgets.find((w) => w.widgetId === "bottom1")).toEqual(bottom1)
    expect(preview.widgets.find((w) => w.widgetId === "bottom2")).toEqual(bottom2)
    expect(preview.widgets.filter((w) => w.y === 0).map((w) => w.widgetId)).toEqual(["top1", "e", "top2"])
    expect(preview.grid.rows).toBe(2)
    expect(preview.grid.columns).toBe(3)
    expect(validateLayout(preview).valid).toBe(true)
  })

  it("GAP-2F: inserting into the second row leaves the first row untouched and keeps the new widget at the second row's y", () => {
    const top1: DashboardWidget = { widgetId: "top1", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 }
    const bottom1: DashboardWidget = { widgetId: "bottom1", widgetType: "contribution-ring", x: 0, y: 1, width: 1, height: 1 }
    const bottom2: DashboardWidget = { widgetId: "bottom2", widgetType: "insights", x: 1, y: 1, width: 1, height: 1 }
    const twoRowBase: CanonicalLayout = { grid: { columns: 2, rows: 2 }, widgets: [top1, bottom1, bottom2] }

    const preview = computeRowInsertionPreview(twoRowBase, [bottom1, bottom2], CANDIDATE, 2)

    expect(preview.widgets.find((w) => w.widgetId === "top1")).toEqual(top1)
    const inserted = preview.widgets.find((w) => w.widgetId === "e")
    expect(inserted).toEqual({ widgetId: "e", widgetType: "insights", x: 2, y: 1, width: 1, height: 1 })
    expect(validateLayout(preview).valid).toBe(true)
  })

  it("a slot that would exceed the supported 1x1-3x3 grid range is rejected by the canonical validator (AC8)", () => {
    const threeWide: DashboardWidget[] = Array.from({ length: 3 }, (_, i) => ({
      widgetId: `w${i}`,
      widgetType: "kpi-summary",
      x: i,
      y: 0,
      width: 1,
      height: 1,
    }))
    const base: CanonicalLayout = { grid: { columns: 3, rows: 1 }, widgets: threeWide }
    const preview = computeRowInsertionPreview(base, threeWide, CANDIDATE, 2)

    expect(preview.grid.columns).toBe(4)
    const result = validateLayout(preview)
    expect(result.valid).toBe(false)
    expect(result.errors.map((e) => e.code)).toContain("INVALID_GRID_SIZE")
  })
})

describe("computeValidatedRowInsertion (GAP-7)", () => {
  it("returns exactly the computeRowInsertionPreview layout, plus its canonical validity", () => {
    const result = computeValidatedRowInsertion(BASE, [A, B], CANDIDATE, 1)
    expect(result.layout).toEqual(computeRowInsertionPreview(BASE, [A, B], CANDIDATE, 1))
    expect(result.valid).toBe(true)
  })

  it("flags a slot that would exceed the 3-column grid maximum as invalid", () => {
    const threeWide = Array.from({ length: 3 }, (_, i) => ({ ...A, widgetId: `w${i}`, x: i }))
    const base: CanonicalLayout = { grid: { columns: 3, rows: 1 }, widgets: threeWide }
    expect(computeValidatedRowInsertion(base, threeWide, CANDIDATE, 2).valid).toBe(false)
  })
})
