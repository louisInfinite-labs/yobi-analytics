import { describe, expect, it } from "vitest"
import { COMPARISON_WIDGET_TYPE, applyCreatorComparisonSelection, isComparisonCapableWidget } from "./dashboardComparisonWidgets"
import type { CanonicalLayout } from "../../editor/model/dashboardLayout"

const TARGET_WIDGET_ID = "comparison-widget"

const LAYOUT: CanonicalLayout = {
  grid: { columns: 2, rows: 2 },
  widgets: [
    {
      widgetId: TARGET_WIDGET_ID,
      widgetType: COMPARISON_WIDGET_TYPE,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      comparison: { creatorIds: ["creator-a", "creator-b"], comparisonItemIds: [] },
    },
    { widgetId: "unrelated-widget", widgetType: "kpi-summary", x: 1, y: 0, width: 1, height: 1 },
  ],
}

describe("isComparisonCapableWidget", () => {
  it("is true for the comparison chart widget type", () => {
    expect(isComparisonCapableWidget(LAYOUT.widgets[0])).toBe(true)
  })

  it("is false for any other widget type (AC1: must not silently receive comparison configuration)", () => {
    expect(isComparisonCapableWidget(LAYOUT.widgets[1])).toBe(false)
  })
})

describe("applyCreatorComparisonSelection", () => {
  it("MT-11 AC4: updates only the target widget's draft creatorIds to A vs B", () => {
    const fresh: CanonicalLayout = {
      grid: { columns: 2, rows: 2 },
      widgets: [
        { widgetId: TARGET_WIDGET_ID, widgetType: COMPARISON_WIDGET_TYPE, x: 0, y: 0, width: 1, height: 1 },
        { widgetId: "unrelated-widget", widgetType: "kpi-summary", x: 1, y: 0, width: 1, height: 1 },
      ],
    }
    const result = applyCreatorComparisonSelection(fresh, TARGET_WIDGET_ID, ["creator-a", "creator-b"])

    expect(result.widgets.find((w) => w.widgetId === TARGET_WIDGET_ID)?.comparison?.creatorIds).toEqual(["creator-a", "creator-b"])
    // Unrelated widget is not merely deep-equal but the exact same reference.
    expect(result.widgets.find((w) => w.widgetId === "unrelated-widget")).toBe(fresh.widgets[1])
  })

  it("MT-11 AC5: adding C preserves existing A/B order", () => {
    const result = applyCreatorComparisonSelection(LAYOUT, TARGET_WIDGET_ID, ["creator-a", "creator-b", "creator-c"])
    expect(result.widgets.find((w) => w.widgetId === TARGET_WIDGET_ID)?.comparison?.creatorIds).toEqual([
      "creator-a",
      "creator-b",
      "creator-c",
    ])
  })

  it("changes only the target widget's `comparison` field -- geometry and widgetType are untouched", () => {
    const result = applyCreatorComparisonSelection(LAYOUT, TARGET_WIDGET_ID, ["creator-a", "creator-b", "creator-c"])
    const target = result.widgets.find((w) => w.widgetId === TARGET_WIDGET_ID)!
    expect(target.widgetId).toBe(TARGET_WIDGET_ID)
    expect(target.widgetType).toBe(COMPARISON_WIDGET_TYPE)
    expect(target.x).toBe(0)
    expect(target.y).toBe(0)
    expect(target.width).toBe(1)
    expect(target.height).toBe(1)
  })

  it("canonical layout passed in is never mutated in place", () => {
    const before = JSON.parse(JSON.stringify(LAYOUT))
    applyCreatorComparisonSelection(LAYOUT, TARGET_WIDGET_ID, ["creator-a", "creator-b", "creator-c"])
    expect(LAYOUT).toEqual(before)
  })

  it("deduplicates the incoming creatorIds while preserving first-occurrence order", () => {
    const result = applyCreatorComparisonSelection(LAYOUT, TARGET_WIDGET_ID, ["creator-a", "creator-b", "creator-a"])
    expect(result.widgets.find((w) => w.widgetId === TARGET_WIDGET_ID)?.comparison?.creatorIds).toEqual(["creator-a", "creator-b"])
  })

  it("AC1: leaves the layout completely unchanged when the target widget is not comparison-capable", () => {
    const result = applyCreatorComparisonSelection(LAYOUT, "unrelated-widget", ["creator-a", "creator-b"])
    expect(result).toBe(LAYOUT)
    expect(result.widgets.find((w) => w.widgetId === "unrelated-widget")?.comparison).toBeUndefined()
  })

  it("leaves the layout unchanged for a nonexistent widgetId", () => {
    const result = applyCreatorComparisonSelection(LAYOUT, "does-not-exist", ["creator-a", "creator-b"])
    expect(result).toBe(LAYOUT)
  })

  it("preserves existing comparisonItemIds on the target widget", () => {
    const withItems: CanonicalLayout = {
      grid: { columns: 2, rows: 2 },
      widgets: [
        {
          widgetId: TARGET_WIDGET_ID,
          widgetType: COMPARISON_WIDGET_TYPE,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          comparison: { creatorIds: ["creator-a", "creator-b"], comparisonItemIds: ["revenue"] },
        },
      ],
    }
    const result = applyCreatorComparisonSelection(withItems, TARGET_WIDGET_ID, ["creator-a", "creator-b", "creator-c"])
    expect(result.widgets[0].comparison?.comparisonItemIds).toEqual(["revenue"])
  })
})
