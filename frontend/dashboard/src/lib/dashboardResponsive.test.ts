import { describe, expect, it } from "vitest"
import { BREAKPOINT_COLUMN_LIMIT, MIN_CHART_WIDTH_PX, reflowLayoutForBreakpoint } from "./dashboardResponsive"
import { computeWidgetPixelRect } from "./dashboardSpacing"
import type { CanonicalLayout, DashboardWidget } from "../types/dashboardLayout"
import type { Breakpoint } from "../types/widget"

// The shared deterministic fixture (DASHBOARD_LAYOUT_IMPLEMENTATION_TASKS.md
// "Shared Deterministic Fixtures"): A|B top row, C|D bottom row.
const SIMPLE_LAYOUT: CanonicalLayout = {
  grid: { columns: 2, rows: 2 },
  widgets: [
    { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
    { widgetId: "c", widgetType: "growth-bar-chart", x: 0, y: 1, width: 1, height: 1 },
    { widgetId: "d", widgetType: "insights", x: 1, y: 1, width: 1, height: 1 },
  ],
}

// A denser fixture mixing 1X and stacked 0.5X widgets, closer to a real
// dashboard than the 4-equal-cell fixture above.
const MIXED_HEIGHT_LAYOUT: CanonicalLayout = {
  grid: { columns: 2, rows: 2 },
  widgets: [
    { widgetId: "wide", widgetType: "kpi-summary", x: 0, y: 0, width: 2, height: 1 },
    { widgetId: "half-top", widgetType: "ranking", x: 0, y: 1, width: 1, height: 0.5 },
    { widgetId: "half-bottom", widgetType: "insights", x: 0, y: 1.5, width: 1, height: 0.5 },
    { widgetId: "tall", widgetType: "growth-bar-chart", x: 1, y: 1, width: 1, height: 1 },
  ],
}

const BREAKPOINTS: Breakpoint[] = ["desktop", "tablet", "mobile"]

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

describe("reflowLayoutForBreakpoint", () => {
  it("MT-16 AC1: every breakpoint produces a deterministic (repeatable) widget order", () => {
    for (const breakpoint of BREAKPOINTS) {
      const first = reflowLayoutForBreakpoint(SIMPLE_LAYOUT, breakpoint).widgets.map((w) => w.widgetId)
      const second = reflowLayoutForBreakpoint(SIMPLE_LAYOUT, breakpoint).widgets.map((w) => w.widgetId)
      expect(second).toEqual(first)
    }
  })

  it("MT-16 AC1: order is row-major (top-to-bottom, then left-to-right), independent of storage-array order", () => {
    const shuffled: CanonicalLayout = { ...SIMPLE_LAYOUT, widgets: [SIMPLE_LAYOUT.widgets[3], SIMPLE_LAYOUT.widgets[0], SIMPLE_LAYOUT.widgets[2], SIMPLE_LAYOUT.widgets[1]] }
    for (const breakpoint of BREAKPOINTS) {
      expect(reflowLayoutForBreakpoint(shuffled, breakpoint).widgets.map((w) => w.widgetId)).toEqual(["a", "b", "c", "d"])
    }
  })

  it.each(BREAKPOINTS)("MT-16 AC2: %s reflow produces no overlaps and no overflow (simple fixture)", (breakpoint) => {
    const reflowed = reflowLayoutForBreakpoint(SIMPLE_LAYOUT, breakpoint)
    for (const widget of reflowed.widgets) {
      expect(widget.x).toBeGreaterThanOrEqual(0)
      expect(widget.y).toBeGreaterThanOrEqual(0)
      expect(widget.x + widget.width).toBeLessThanOrEqual(reflowed.columns)
      expect(widget.y + widget.height).toBeLessThanOrEqual(reflowed.rows)
    }
    for (let i = 0; i < reflowed.widgets.length; i++) {
      for (let j = i + 1; j < reflowed.widgets.length; j++) {
        expect(overlaps(reflowed.widgets[i], reflowed.widgets[j])).toBe(false)
      }
    }
  })

  it.each(BREAKPOINTS)("MT-16 AC2: %s reflow produces no overlaps and no overflow (mixed-height fixture)", (breakpoint) => {
    const reflowed = reflowLayoutForBreakpoint(MIXED_HEIGHT_LAYOUT, breakpoint)
    for (const widget of reflowed.widgets) {
      expect(widget.x + widget.width).toBeLessThanOrEqual(reflowed.columns)
      expect(widget.y + widget.height).toBeLessThanOrEqual(reflowed.rows)
    }
    for (let i = 0; i < reflowed.widgets.length; i++) {
      for (let j = i + 1; j < reflowed.widgets.length; j++) {
        expect(overlaps(reflowed.widgets[i], reflowed.widgets[j])).toBe(false)
      }
    }
  })

  it.each(BREAKPOINTS)("MT-16 AC4: %s reflow preserves the exact set of widgetIds", (breakpoint) => {
    const reflowed = reflowLayoutForBreakpoint(MIXED_HEIGHT_LAYOUT, breakpoint)
    const originalIds = MIXED_HEIGHT_LAYOUT.widgets.map((w) => w.widgetId).sort()
    const reflowedIds = reflowed.widgets.map((w) => w.widgetId).sort()
    expect(reflowedIds).toEqual(originalIds)
  })

  it("mobile stacks every widget to a single full-width column", () => {
    const reflowed = reflowLayoutForBreakpoint(SIMPLE_LAYOUT, "mobile")
    expect(reflowed.columns).toBe(1)
    expect(reflowed.widgets.every((w) => w.x === 0 && w.width === 1)).toBe(true)
  })

  it("desktop returns the layout unchanged (geometry and order untouched)", () => {
    const reflowed = reflowLayoutForBreakpoint(SIMPLE_LAYOUT, "desktop")
    expect(reflowed).toEqual({ columns: 2, rows: 2, widgets: SIMPLE_LAYOUT.widgets })
  })

  it("tablet packs two width-1 widgets side by side on the same shelf when both fit", () => {
    const reflowed = reflowLayoutForBreakpoint(SIMPLE_LAYOUT, "tablet")
    expect(reflowed.columns).toBe(2)
    // a and b share y=0 (row 0's shelf); c and d share y=1 -- genuine
    // side-by-side placement, not every widget forced to full width.
    const byId = Object.fromEntries(reflowed.widgets.map((w) => [w.widgetId, w]))
    expect(byId.a).toMatchObject({ x: 0, y: 0, width: 1 })
    expect(byId.b).toMatchObject({ x: 1, y: 0, width: 1 })
    expect(byId.c).toMatchObject({ x: 0, y: 1, width: 1 })
    expect(byId.d).toMatchObject({ x: 1, y: 1, width: 1 })
  })

  const GRID_PIXEL_CONFIG = { columnWidthPx: 320, rowHeightPx: 240 }

  /** Adjacency is decided in grid units (an edge of `a` exactly meets an
   * edge of `b`, with an overlapping perpendicular range) before any pixel
   * math -- not "same pixel row/column," which would also match two
   * same-column widgets separated by a third one in between. */
  function assertAllAdjacentGapsAre16px(widgets: readonly DashboardWidget[]) {
    const rectByWidgetId = new Map(widgets.map((widget) => [widget.widgetId, computeWidgetPixelRect(widget, GRID_PIXEL_CONFIG)]))
    let checkedAtLeastOnePair = false

    for (const a of widgets) {
      for (const b of widgets) {
        if (a === b) continue
        const rectA = rectByWidgetId.get(a.widgetId)!
        const rectB = rectByWidgetId.get(b.widgetId)!

        const horizontallyAdjacent = b.x === a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
        if (horizontallyAdjacent) {
          expect(rectB.left - (rectA.left + rectA.width)).toBe(16)
          checkedAtLeastOnePair = true
        }

        const verticallyAdjacent = b.y === a.y + a.height && a.x < b.x + b.width && b.x < a.x + a.width
        if (verticallyAdjacent) {
          expect(rectB.top - (rectA.top + rectA.height)).toBe(16)
          checkedAtLeastOnePair = true
        }
      }
    }
    expect(checkedAtLeastOnePair).toBe(true)
  }

  it("MT-16 AC3 (desktop): every adjacent widget pair in the unchanged desktop layout measures exactly 16px apart", () => {
    const reflowed = reflowLayoutForBreakpoint(SIMPLE_LAYOUT, "desktop")
    // a|b horizontally adjacent, a/c and b/d vertically adjacent -- real
    // desktop 2x2 geometry, not inferred from another breakpoint.
    assertAllAdjacentGapsAre16px(reflowed.widgets)
  })

  it("MT-16 AC3 (tablet): every adjacent widget pair in the tablet shelf-packed layout measures exactly 16px apart, including the new horizontal a|b and c|d pairs", () => {
    const reflowed = reflowLayoutForBreakpoint(SIMPLE_LAYOUT, "tablet")
    assertAllAdjacentGapsAre16px(reflowed.widgets)
  })

  it("MT-16 AC3 (mobile): every adjacent widget pair in the mobile single-column stack measures exactly 16px apart", () => {
    const reflowed = reflowLayoutForBreakpoint(SIMPLE_LAYOUT, "mobile")
    assertAllAdjacentGapsAre16px(reflowed.widgets)
  })
})

describe("BREAKPOINT_COLUMN_LIMIT / MIN_CHART_WIDTH_PX", () => {
  it("mobile is a single deterministic column", () => {
    expect(BREAKPOINT_COLUMN_LIMIT.mobile).toBe(1)
  })

  it("desktop allows the full canonical 1-5 column range", () => {
    expect(BREAKPOINT_COLUMN_LIMIT.desktop).toBe(5)
  })

  it("defines a positive minimum chart width", () => {
    expect(MIN_CHART_WIDTH_PX).toBeGreaterThan(0)
  })
})
