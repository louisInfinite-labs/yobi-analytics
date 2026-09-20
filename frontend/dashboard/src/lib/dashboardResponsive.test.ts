import { describe, expect, it } from "vitest"
import { BREAKPOINT_COLUMN_LIMIT, BREAKPOINT_MAX_EDITABLE_GRID, MIN_CHART_WIDTH_PX, computeReadableColumnCap, reflowLayoutForBreakpoint } from "./dashboardResponsive"
import { computeWidgetPixelRect, DASHBOARD_ELEMENT_GAP_PX } from "./dashboardSpacing"
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

  it("desktop allows the full canonical 1-3 column range", () => {
    expect(BREAKPOINT_COLUMN_LIMIT.desktop).toBe(3)
  })

  it("GAP-8D: desktop and tablet editable maximum is 3x3; mobile is not editable", () => {
    expect(BREAKPOINT_MAX_EDITABLE_GRID).toEqual({ desktop: 3, tablet: 3, mobile: 1 })
  })

  it("defines a positive minimum chart width", () => {
    expect(MIN_CHART_WIDTH_PX).toBeGreaterThan(0)
  })
})

describe("computeReadableColumnCap (GAP-5B1, corrected in GAP-8)", () => {
  it("matches the measured real numbers: 644px content (768px tablet viewport) yields 2 columns, 776px (900px viewport) yields 3", () => {
    expect(computeReadableColumnCap(644, 3)).toBe(2)
    expect(computeReadableColumnCap(776, 3)).toBe(3)
  })

  it(`never returns fewer than 1 column even when content width is far below ${MIN_CHART_WIDTH_PX}px`, () => {
    expect(computeReadableColumnCap(10, 3)).toBe(1)
  })

  it("never exceeds the caller-supplied maximum even when content width could fit more", () => {
    expect(computeReadableColumnCap(10000, 3)).toBe(3)
  })

  // GridStack insets every widget by 8px on all sides, so n columns render at
  // W / n - 16 px each: n columns are readable iff W >= n * (240 + 16).
  it.each([
    [1, 256],
    [2, 512],
    [3, 768],
  ])("%i column(s): exactly %ipx admits n, one pixel less admits n-1 (never a sub-240 widget)", (n, threshold) => {
    expect(computeReadableColumnCap(threshold, 3)).toBe(n)
    expect(computeReadableColumnCap(threshold - 1, 3)).toBe(Math.max(1, n - 1))
    // The widget width the cap promises really is >= the minimum at the threshold...
    expect(threshold / n - DASHBOARD_ELEMENT_GAP_PX).toBeGreaterThanOrEqual(MIN_CHART_WIDTH_PX)
    // ...and one pixel below it is genuinely under the minimum (no rounding excuse).
    if (n > 1) expect((threshold - 1) / n - DASHBOARD_ELEMENT_GAP_PX).toBeLessThan(MIN_CHART_WIDTH_PX)
  })

  it("for every width from 256px (the narrowest that can hold even one 240px widget) to 1600px, the accepted column count (never above the product maximum of 3) never renders a widget below the minimum", () => {
    for (let width = 256; width <= 1600; width++) {
      const cap = computeReadableColumnCap(width, 3)
      expect(cap).toBeLessThanOrEqual(3)
      expect(width / cap - DASHBOARD_ELEMENT_GAP_PX).toBeGreaterThanOrEqual(MIN_CHART_WIDTH_PX)
    }
  })

  it("below 256px no column count can give a 240px widget: the cap clamps to 1 (an unsupported width -- the narrowest editable production grid is ~644px on tablet, ~900px on desktop)", () => {
    for (let width = 1; width < 256; width++) {
      expect(computeReadableColumnCap(width, 3)).toBe(1)
      expect(width - DASHBOARD_ELEMENT_GAP_PX).toBeLessThan(MIN_CHART_WIDTH_PX)
    }
  })
})

describe("reflowLayoutForBreakpoint columnCapOverride (GAP-5B1)", () => {
  it("uses the override instead of BREAKPOINT_COLUMN_LIMIT when supplied", () => {
    const threeColumn: CanonicalLayout = {
      grid: { columns: 3, rows: 1 },
      widgets: [
        { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
        { widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
        { widgetId: "c", widgetType: "growth-bar-chart", x: 2, y: 0, width: 1, height: 1 },
      ],
    }
    // Default tablet cap (BREAKPOINT_COLUMN_LIMIT.tablet = 2) would also
    // produce 2 here, so use an override the default cap could never
    // produce (1) to prove the override -- not the default -- is what ran.
    const withOverride = reflowLayoutForBreakpoint(threeColumn, "tablet", 1)
    expect(withOverride.columns).toBe(1)
    expect(new Set(withOverride.widgets.map((w) => w.x))).toEqual(new Set([0]))
  })

  it("omitting the override preserves the exact pre-existing BREAKPOINT_COLUMN_LIMIT behavior", () => {
    const withoutOverride = reflowLayoutForBreakpoint(SIMPLE_LAYOUT, "tablet")
    const explicitDefault = reflowLayoutForBreakpoint(SIMPLE_LAYOUT, "tablet", BREAKPOINT_COLUMN_LIMIT.tablet)
    expect(withoutOverride).toEqual(explicitDefault)
  })

  it("desktop keeps canonical geometry when the layout fits the override (GAP-8)", () => {
    expect(reflowLayoutForBreakpoint(SIMPLE_LAYOUT, "desktop", 2)).toEqual({ columns: 2, rows: 2, widgets: SIMPLE_LAYOUT.widgets })
    expect(reflowLayoutForBreakpoint(SIMPLE_LAYOUT, "desktop")).toEqual({ columns: 2, rows: 2, widgets: SIMPLE_LAYOUT.widgets })
  })

  it("desktop reflows a layout wider than the readable cap deterministically, without overlap or overflow (GAP-8)", () => {
    const threeWide: CanonicalLayout = {
      grid: { columns: 3, rows: 1 },
      widgets: Array.from({ length: 3 }, (_, i) => ({ widgetId: `w${i}`, widgetType: "kpi-summary", x: i, y: 0, width: 1 as const, height: 1 as const })),
    }
    const first = reflowLayoutForBreakpoint(threeWide, "desktop", 2)
    const second = reflowLayoutForBreakpoint(threeWide, "desktop", 2)

    expect(first).toEqual(second)
    expect(first.columns).toBe(2)
    expect(first.widgets.map((w) => w.widgetId)).toEqual(["w0", "w1", "w2"])
    expect(first.widgets.map((w) => [w.x, w.y])).toEqual([[0, 0], [1, 0], [0, 1]])
    for (const w of first.widgets) expect(w.x + w.width).toBeLessThanOrEqual(first.columns)
    for (let i = 0; i < first.widgets.length; i++) for (let j = i + 1; j < first.widgets.length; j++) expect(overlaps(first.widgets[i], first.widgets[j])).toBe(false)
    // The input layout is never mutated.
    expect(threeWide.widgets.map((w) => w.x)).toEqual([0, 1, 2])
  })
})
