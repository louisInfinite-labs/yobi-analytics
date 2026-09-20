import { describe, expect, it } from "vitest"
import {
  GRIDSTACK_ROW_SCALE,
  canonicalGridToGridStackColumnCount,
  canonicalWidgetToGridStackNode,
  gridStackNodeToCanonicalCandidate,
  minGridStackHeightForAllowedHeights,
  type CanonicalGeometryCandidate,
} from "./gridStackGeometryAdapter"
import type { DashboardWidget, GridSize } from "../model/dashboardLayout"

function widget(overrides: Partial<DashboardWidget> = {}): DashboardWidget {
  return { widgetId: "widget-a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1, ...overrides }
}

function roundTrip(source: DashboardWidget): CanonicalGeometryCandidate {
  const node = canonicalWidgetToGridStackNode(source)
  return gridStackNodeToCanonicalCandidate(node, source.widgetId, source.widgetType)
}

describe("canonicalWidgetToGridStackNode", () => {
  it("preserves widgetId as the GridStack node id", () => {
    const node = canonicalWidgetToGridStackNode(widget({ widgetId: "widget-xyz" }))
    expect(node.id).toBe("widget-xyz")
  })

  it("passes x and width through unscaled", () => {
    const node = canonicalWidgetToGridStackNode(widget({ x: 2, width: 3 }))
    expect(node.x).toBe(2)
    expect(node.w).toBe(3)
  })

  it("scales a 1X widget to 2 GridStack rows starting on an even row", () => {
    const node = canonicalWidgetToGridStackNode(widget({ y: 1, height: 1 }))
    expect(node.y).toBe(2)
    expect(node.h).toBe(2)
  })

  it("scales a 0.5X widget to 1 GridStack row", () => {
    const node = canonicalWidgetToGridStackNode(widget({ y: 0.5, height: 0.5 }))
    expect(node.y).toBe(1)
    expect(node.h).toBe(1)
  })

  it("is deterministic for the same input", () => {
    const source = widget({ widgetId: "widget-det", x: 1, y: 1.5, width: 2, height: 0.5 })
    expect(canonicalWidgetToGridStackNode(source)).toEqual(canonicalWidgetToGridStackNode(source))
  })
})

describe("canonicalGridToGridStackColumnCount", () => {
  it.each<GridSize>([
    { columns: 1, rows: 1 },
    { columns: 2, rows: 2 },
    { columns: 3, rows: 2 },
    { columns: 3, rows: 3 },
  ])("maps a %o grid's columns 1:1 to the GridStack column count", (grid) => {
    expect(canonicalGridToGridStackColumnCount(grid)).toBe(grid.columns)
  })
})

describe("gridStackNodeToCanonicalCandidate", () => {
  it("preserves the supplied widgetId and widgetType", () => {
    const candidate = gridStackNodeToCanonicalCandidate(
      { x: 0, y: 0, w: 1, h: GRIDSTACK_ROW_SCALE },
      "widget-preserved",
      "ranking",
    )
    expect(candidate.widgetId).toBe("widget-preserved")
    expect(candidate.widgetType).toBe("ranking")
  })

  it("does not mutate or return any layout object (candidate only)", () => {
    const candidate = gridStackNodeToCanonicalCandidate({ x: 0, y: 0, w: 1, h: 2 }, "widget-a", "kpi-summary")
    expect(candidate).not.toHaveProperty("layout")
    expect(candidate).not.toHaveProperty("widgets")
    expect(candidate).not.toHaveProperty("grid")
  })

  it.each([
    [0, 0.5],
    [1, 0.5],
    [1.5, 1],
    [2, 1],
  ])("snaps a raw GridStack height of %i rows to canonical height %s", (h, expectedHeight) => {
    const candidate = gridStackNodeToCanonicalCandidate({ x: 0, y: 0, w: 1, h }, "widget-a", "kpi-summary")
    expect(candidate.height).toBe(expectedHeight)
  })
})

describe("round trip: canonical -> GridStack -> canonical candidate", () => {
  it("reproduces exact geometry for a 1x1 grid with one 1X widget", () => {
    const source = widget({ widgetId: "w0", widgetType: "growth-bar-chart", x: 0, y: 0, width: 1, height: 1 })
    expect(roundTrip(source)).toEqual({
      widgetId: source.widgetId,
      widgetType: source.widgetType,
      x: source.x,
      y: source.y,
      width: source.width,
      height: source.height,
    })
  })

  it("reproduces exact geometry for every widget in a 2x2 grid of 1X widgets", () => {
    const fixtures: DashboardWidget[] = [
      widget({ widgetId: "a", x: 0, y: 0, width: 1, height: 1 }),
      widget({ widgetId: "b", x: 1, y: 0, width: 1, height: 1 }),
      widget({ widgetId: "c", x: 0, y: 1, width: 1, height: 1 }),
      widget({ widgetId: "d", x: 1, y: 1, width: 1, height: 1 }),
    ]
    for (const source of fixtures) {
      expect(roundTrip(source)).toEqual({
        widgetId: source.widgetId,
        widgetType: source.widgetType,
        x: source.x,
        y: source.y,
        width: source.width,
        height: source.height,
      })
    }
  })

  it("reproduces exact geometry for stacked 0.5X widgets in a 2x2 grid", () => {
    const fixtures: DashboardWidget[] = [
      widget({ widgetId: "top", x: 0, y: 0, width: 1, height: 0.5 }),
      widget({ widgetId: "bottom", x: 0, y: 0.5, width: 1, height: 0.5 }),
    ]
    for (const source of fixtures) {
      expect(roundTrip(source)).toEqual({
        widgetId: source.widgetId,
        widgetType: source.widgetType,
        x: source.x,
        y: source.y,
        width: source.width,
        height: source.height,
      })
    }
  })

  it("reproduces exact geometry on a 3-column grid, including a stacked 0.5X pair", () => {
    const fixtures: DashboardWidget[] = [
      widget({ widgetId: "wide", x: 0, y: 0, width: 3, height: 1 }),
      widget({ widgetId: "half-top", x: 0, y: 1, width: 2, height: 0.5 }),
      widget({ widgetId: "half-bottom", x: 0, y: 1.5, width: 2, height: 0.5 }),
    ]
    for (const source of fixtures) {
      expect(roundTrip(source)).toEqual({
        widgetId: source.widgetId,
        widgetType: source.widgetType,
        x: source.x,
        y: source.y,
        width: source.width,
        height: source.height,
      })
    }
  })

  it("reproduces exact geometry on a 5-column grid, including a stacked 0.5X pair", () => {
    const fixtures: DashboardWidget[] = [
      widget({ widgetId: "full-width", x: 0, y: 0, width: 5, height: 1 }),
      widget({ widgetId: "narrow-top", x: 4, y: 1, width: 1, height: 0.5 }),
      widget({ widgetId: "narrow-bottom", x: 4, y: 1.5, width: 1, height: 0.5 }),
    ]
    for (const source of fixtures) {
      expect(roundTrip(source)).toEqual({
        widgetId: source.widgetId,
        widgetType: source.widgetType,
        x: source.x,
        y: source.y,
        width: source.width,
        height: source.height,
      })
    }
  })
})

describe("minGridStackHeightForAllowedHeights", () => {
  it("scales the smallest allowed canonical height by GRIDSTACK_ROW_SCALE", () => {
    expect(minGridStackHeightForAllowedHeights([0.5, 1])).toBe(1)
    expect(minGridStackHeightForAllowedHeights([1])).toBe(2)
  })

  it("is independent of array order", () => {
    expect(minGridStackHeightForAllowedHeights([1, 0.5])).toBe(1)
  })

  it("never returns a value below GRIDSTACK_ROW_SCALE * 0.5 for any legal canonical height", () => {
    expect(minGridStackHeightForAllowedHeights([0.5])).toBe(0.5 * GRIDSTACK_ROW_SCALE)
  })
})
