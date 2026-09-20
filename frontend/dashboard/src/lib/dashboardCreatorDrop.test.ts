import { describe, expect, it } from "vitest"
import { describeCreatorDrop, dropCreatorOntoWidget } from "./dashboardCreatorDrop"
import { COMPARISON_WIDGET_TYPE } from "./dashboardComparisonWidgets"
import type { CanonicalLayout } from "../types/dashboardLayout"

const LAYOUT: CanonicalLayout = {
  grid: { columns: 2, rows: 2 },
  widgets: [
    {
      widgetId: "comparison-widget",
      widgetType: COMPARISON_WIDGET_TYPE,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      comparison: { creatorIds: ["creator-a"], comparisonItemIds: [] },
    },
    { widgetId: "unrelated-widget", widgetType: "kpi-summary", x: 1, y: 0, width: 1, height: 1 },
  ],
}

describe("dropCreatorOntoWidget", () => {
  it("MT-13 AC1: dropping B onto a chart containing A prepares A vs B", () => {
    const result = dropCreatorOntoWidget(LAYOUT, "comparison-widget", "creator-b")
    expect(result.widgets.find((w) => w.widgetId === "comparison-widget")?.comparison?.creatorIds).toEqual(["creator-a", "creator-b"])
  })

  it("MT-13 AC2: dropping C onto a chart containing A and B prepares A vs B vs C", () => {
    const abLayout: CanonicalLayout = {
      grid: LAYOUT.grid,
      widgets: [{ ...LAYOUT.widgets[0], comparison: { creatorIds: ["creator-a", "creator-b"], comparisonItemIds: [] } }],
    }
    const result = dropCreatorOntoWidget(abLayout, "comparison-widget", "creator-c")
    expect(result.widgets[0].comparison?.creatorIds).toEqual(["creator-a", "creator-b", "creator-c"])
  })

  it("MT-13 AC3: a newly dropped creator receives the next order number (appended to the end)", () => {
    const result = dropCreatorOntoWidget(LAYOUT, "comparison-widget", "creator-b")
    const creatorIds = result.widgets.find((w) => w.widgetId === "comparison-widget")!.comparison!.creatorIds
    expect(creatorIds.indexOf("creator-b")).toBe(creatorIds.length - 1)
  })

  it("MT-13 AC5: dropping onto an incompatible widget is rejected -- layout unchanged", () => {
    const result = dropCreatorOntoWidget(LAYOUT, "unrelated-widget", "creator-b")
    expect(result).toBe(LAYOUT)
    expect(result.widgets.find((w) => w.widgetId === "unrelated-widget")?.comparison).toBeUndefined()
  })

  it("MT-13 AC6: dropping a creator already present adds no duplicate", () => {
    const result = dropCreatorOntoWidget(LAYOUT, "comparison-widget", "creator-a")
    expect(result).toBe(LAYOUT)
  })

  it("MT-13 AC8/AC9: a successful drop updates only the target widget; unrelated widgets are reference-unchanged", () => {
    const result = dropCreatorOntoWidget(LAYOUT, "comparison-widget", "creator-b")
    expect(result.widgets.find((w) => w.widgetId === "unrelated-widget")).toBe(LAYOUT.widgets[1])
  })

  it("preserves target widget geometry and comparisonItemIds", () => {
    const result = dropCreatorOntoWidget(LAYOUT, "comparison-widget", "creator-b")
    const target = result.widgets.find((w) => w.widgetId === "comparison-widget")!
    expect({ widgetId: target.widgetId, x: target.x, y: target.y, width: target.width, height: target.height }).toEqual({
      widgetId: "comparison-widget",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    })
    expect(target.comparison?.comparisonItemIds).toEqual([])
  })

  it("does not mutate the input layout", () => {
    const before = JSON.parse(JSON.stringify(LAYOUT))
    dropCreatorOntoWidget(LAYOUT, "comparison-widget", "creator-b")
    expect(LAYOUT).toEqual(before)
  })

  it("a nonexistent widgetId leaves the layout unchanged", () => {
    const result = dropCreatorOntoWidget(LAYOUT, "does-not-exist", "creator-b")
    expect(result).toBe(LAYOUT)
  })
})

describe("describeCreatorDrop (GAP-9)", () => {
  it("classifies an accepted drop with the comparison order the creator receives", () => {
    expect(describeCreatorDrop(LAYOUT, "comparison-widget", "creator-b")).toEqual({ status: "added", order: 2 })
  })

  it("classifies a creator already in the comparison as a duplicate", () => {
    expect(describeCreatorDrop(LAYOUT, "comparison-widget", "creator-a")).toEqual({ status: "duplicate" })
  })

  it("classifies a non-comparison widget as incompatible and an unknown widget as missing", () => {
    expect(describeCreatorDrop(LAYOUT, "unrelated-widget", "creator-b")).toEqual({ status: "incompatible" })
    expect(describeCreatorDrop(LAYOUT, "nope", "creator-b")).toEqual({ status: "missing" })
  })

  it("agrees with dropCreatorOntoWidget: only an 'added' outcome changes the layout", () => {
    for (const [widgetId, creatorId] of [["comparison-widget", "creator-b"], ["comparison-widget", "creator-a"], ["unrelated-widget", "creator-b"], ["nope", "creator-b"]]) {
      const changed = dropCreatorOntoWidget(LAYOUT, widgetId, creatorId) !== LAYOUT
      expect(changed).toBe(describeCreatorDrop(LAYOUT, widgetId, creatorId).status === "added")
    }
  })
})
