import { describe, expect, it } from "vitest"
import {
  computeWidgetPixelRect,
  widgetToComponentContribution,
  DASHBOARD_ELEMENT_GAP_PX,
  WIDGET_EDGE_CONTRIBUTION_PX,
  type GridPixelConfig,
} from "./dashboardSpacing"

// Representative pixel-per-grid-unit values standing in for different
// breakpoints (AC9) -- the authoritative per-breakpoint column widths are
// MT-16's ("Responsive and Accessibility Verification") to define; this
// proves the 16px contract holds regardless of column/row pixel size,
// which is what MT-06 actually owns.
const BREAKPOINT_GRIDS: Record<string, GridPixelConfig> = {
  desktop: { columnWidthPx: 320, rowHeightPx: 240 },
  tablet: { columnWidthPx: 220, rowHeightPx: 200 },
  mobile: { columnWidthPx: 140, rowHeightPx: 160 },
}

describe("WIDGET_EDGE_CONTRIBUTION_PX / DASHBOARD_ELEMENT_GAP_PX", () => {
  it("the facing edge contribution of each widget is exactly 8px (AC1)", () => {
    expect(WIDGET_EDGE_CONTRIBUTION_PX).toBe(8)
  })

  it("two facing 8px contributions combine to the 16px gap constant", () => {
    expect(WIDGET_EDGE_CONTRIBUTION_PX * 2).toBe(DASHBOARD_ELEMENT_GAP_PX)
  })
})

describe.each(Object.entries(BREAKPOINT_GRIDS))("computeWidgetPixelRect at %s grid pixel sizes", (_name, grid) => {
  it("horizontal adjacent widgets measure exactly 16px apart (AC2)", () => {
    const left = computeWidgetPixelRect({ x: 0, y: 0, width: 1, height: 1 }, grid)
    const right = computeWidgetPixelRect({ x: 1, y: 0, width: 1, height: 1 }, grid)
    const horizontalGap = right.left - (left.left + left.width)
    expect(horizontalGap).toBe(16)
  })

  it("vertical adjacent widgets measure exactly 16px apart (AC3)", () => {
    const upper = computeWidgetPixelRect({ x: 0, y: 0, width: 1, height: 1 }, grid)
    const lower = computeWidgetPixelRect({ x: 0, y: 1, width: 1, height: 1 }, grid)
    const verticalGap = lower.top - (upper.top + upper.height)
    expect(verticalGap).toBe(16)
  })

  it("a vertically stacked pair of 0.5X widgets also measures exactly 16px apart", () => {
    const top = computeWidgetPixelRect({ x: 0, y: 0, width: 1, height: 0.5 }, grid)
    const bottom = computeWidgetPixelRect({ x: 0, y: 0.5, width: 1, height: 0.5 }, grid)
    const verticalGap = bottom.top - (top.top + top.height)
    expect(verticalGap).toBe(16)
  })

  it("no adjacent pair measures 32px (AC4)", () => {
    const left = computeWidgetPixelRect({ x: 0, y: 0, width: 1, height: 1 }, grid)
    const right = computeWidgetPixelRect({ x: 1, y: 0, width: 1, height: 1 }, grid)
    expect(right.left - (left.left + left.width)).not.toBe(32)
  })
})

describe("widgetToComponentContribution", () => {
  it("a 0px-contributing neighbor requires the full 16px from the widget side (AC5)", () => {
    expect(widgetToComponentContribution(0)).toBe(16)
  })

  it("an 8px-contributing neighbor requires 8px from the widget side (AC6)", () => {
    expect(widgetToComponentContribution(8)).toBe(8)
  })

  it("never defaults to a plain 16px on both sides regardless of the component's contribution", () => {
    expect(widgetToComponentContribution(4)).toBe(12)
  })
})
