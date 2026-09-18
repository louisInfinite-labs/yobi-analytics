import { describe, expect, it, vi } from "vitest"
import { computeComparisonMapping, sortWidgetsVisualOrder, submitComparisonTransaction } from "./dashboardComparisonMapping"
import { COMPARISON_WIDGET_TYPE } from "./dashboardComparisonWidgets"
import type { CanonicalLayout } from "../types/dashboardLayout"

const CREATOR_IDS = ["creator-a", "creator-b", "creator-c"]
const ITEM_IDS = ["revenue", "engagement", "growth"]

// Deliberately shuffled storage-array order so visual order cannot
// accidentally equal array order (task's own "Deterministic fixture"
// requirement): stored as [bottom-left, top-left, top-right] but the visual
// layout is:
//   top-left(widget-a)   top-right(widget-b)
//   bottom-left(widget-c)
const SHUFFLED_LAYOUT: CanonicalLayout = {
  grid: { columns: 2, rows: 2 },
  widgets: [
    { widgetId: "widget-c", widgetType: "kpi-summary", x: 0, y: 1, width: 1, height: 1 },
    { widgetId: "widget-a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "widget-b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
  ],
}

describe("sortWidgetsVisualOrder", () => {
  it("sorts top-to-bottom then left-to-right, independent of storage order", () => {
    const ordered = sortWidgetsVisualOrder(SHUFFLED_LAYOUT.widgets)
    expect(ordered.map((w) => w.widgetId)).toEqual(["widget-a", "widget-b", "widget-c"])
  })
})

describe("computeComparisonMapping", () => {
  it("MT-12 AC3-AC5: maps Revenue/Engagement/Growth onto widget[0]/[1]/[2] by visual (not array) order", () => {
    const mapping = computeComparisonMapping(SHUFFLED_LAYOUT, CREATOR_IDS, ITEM_IDS)

    expect(mapping.ok).toBe(true)
    expect(mapping.assignments).toEqual([
      { widgetId: "widget-a", comparisonItemId: "revenue", widgetIndex: 0 },
      { widgetId: "widget-b", comparisonItemId: "engagement", widgetIndex: 1 },
      { widgetId: "widget-c", comparisonItemId: "growth", widgetIndex: 2 },
    ])
    expect(mapping.appendedWidgetIds).toEqual([])
  })

  it("MT-12 AC1-AC2: applies the same ordered creatorIds (not source-list order) to every assigned widget", () => {
    const mapping = computeComparisonMapping(SHUFFLED_LAYOUT, ["creator-c", "creator-a"], ["revenue"])
    const widgetA = mapping.resultingLayout.widgets.find((w) => w.widgetId === "widget-a")!
    expect(widgetA.comparison?.creatorIds).toEqual(["creator-c", "creator-a"]) // click order, not alphabetical/source order
  })

  it("MT-12 AC6: reused widgets preserve widgetId, x, y, width, height -- only widgetType/comparison change", () => {
    const mapping = computeComparisonMapping(SHUFFLED_LAYOUT, CREATOR_IDS, ITEM_IDS)
    const before = SHUFFLED_LAYOUT.widgets.find((w) => w.widgetId === "widget-a")!
    const after = mapping.resultingLayout.widgets.find((w) => w.widgetId === "widget-a")!

    expect({ widgetId: after.widgetId, x: after.x, y: after.y, width: after.width, height: after.height }).toEqual({
      widgetId: before.widgetId,
      x: before.x,
      y: before.y,
      width: before.width,
      height: before.height,
    })
    expect(after.widgetType).toBe(COMPARISON_WIDGET_TYPE)
    expect(after.comparison?.comparisonItemIds).toEqual(["revenue"])
  })

  it("MT-12 AC7-AC8: appends exactly one new widget with a unique widgetId when 3 items but only 2 containers exist", () => {
    const twoWidgetLayout: CanonicalLayout = {
      grid: { columns: 2, rows: 2 },
      widgets: [
        { widgetId: "widget-a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
        { widgetId: "widget-b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
      ],
    }
    const mapping = computeComparisonMapping(twoWidgetLayout, CREATOR_IDS, ITEM_IDS)

    expect(mapping.ok).toBe(true)
    expect(mapping.appendedWidgetIds).toHaveLength(1)
    expect(mapping.resultingLayout.widgets).toHaveLength(3)
    expect(new Set(mapping.resultingLayout.widgets.map((w) => w.widgetId)).size).toBe(3) // unique
    const appended = mapping.resultingLayout.widgets.find((w) => w.widgetId === mapping.appendedWidgetIds[0])!
    expect(appended.x).toBe(0)
    expect(appended.y).toBe(1) // next unoccupied slot: bottom-left
    expect(appended.comparison?.comparisonItemIds).toEqual(["growth"])
  })

  it("MT-12 AC9: pre-existing widgets retain their original coordinates and sizes after mapping", () => {
    const twoWidgetLayout: CanonicalLayout = {
      grid: { columns: 2, rows: 2 },
      widgets: [
        { widgetId: "widget-a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
        { widgetId: "widget-b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
      ],
    }
    const mapping = computeComparisonMapping(twoWidgetLayout, CREATOR_IDS, ["revenue", "engagement"])

    for (const before of twoWidgetLayout.widgets) {
      const after = mapping.resultingLayout.widgets.find((w) => w.widgetId === before.widgetId)!
      expect({ x: after.x, y: after.y, width: after.width, height: after.height }).toEqual({
        x: before.x,
        y: before.y,
        width: before.width,
        height: before.height,
      })
    }
  })

  it("MT-12 AC10: with 5 widgets and 3 selected items, widgets 3 and 4 (visual index) remain completely unchanged", () => {
    const fiveWidgetLayout: CanonicalLayout = {
      grid: { columns: 5, rows: 1 },
      widgets: Array.from({ length: 5 }, (_, i) => ({
        widgetId: `w${i}`,
        widgetType: "kpi-summary",
        x: i,
        y: 0,
        width: 1 as const,
        height: 1 as const,
      })),
    }
    const mapping = computeComparisonMapping(fiveWidgetLayout, CREATOR_IDS, ITEM_IDS)

    expect(mapping.assignments.map((a) => a.widgetId)).toEqual(["w0", "w1", "w2"])
    const w3After = mapping.resultingLayout.widgets.find((w) => w.widgetId === "w3")!
    const w4After = mapping.resultingLayout.widgets.find((w) => w.widgetId === "w4")!
    // Untouched widgets are returned by the exact same object reference.
    expect(w3After).toBe(fiveWidgetLayout.widgets[3])
    expect(w4After).toBe(fiveWidgetLayout.widgets[4])
  })

  it("MT-12 AC11: no valid slot -- returns ok:false, appends nothing, and leaves the layout byte-for-byte unchanged", () => {
    const fullLayout: CanonicalLayout = {
      grid: { columns: 1, rows: 1 },
      widgets: [{ widgetId: "widget-a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 }],
    }
    const mapping = computeComparisonMapping(fullLayout, CREATOR_IDS, ["revenue", "engagement"])

    expect(mapping.ok).toBe(false)
    expect(mapping.reason).toBe("INSUFFICIENT_CAPACITY")
    expect(mapping.appendedWidgetIds).toEqual([])
    expect(mapping.assignments).toEqual([])
    expect(mapping.resultingLayout).toBe(fullLayout) // unchanged, same reference
  })

  it("does not mutate the input canonicalLayout merely by computing a preview (AC12's non-mutating requirement)", () => {
    const before = JSON.parse(JSON.stringify(SHUFFLED_LAYOUT))
    computeComparisonMapping(SHUFFLED_LAYOUT, CREATOR_IDS, ITEM_IDS)
    expect(SHUFFLED_LAYOUT).toEqual(before)
  })

  it("fewer items than containers leaves the unassigned container(s) untouched", () => {
    const mapping = computeComparisonMapping(SHUFFLED_LAYOUT, CREATOR_IDS, ["revenue"])
    const untouchedB = mapping.resultingLayout.widgets.find((w) => w.widgetId === "widget-b")!
    const untouchedC = mapping.resultingLayout.widgets.find((w) => w.widgetId === "widget-c")!
    expect(untouchedB).toBe(SHUFFLED_LAYOUT.widgets.find((w) => w.widgetId === "widget-b"))
    expect(untouchedC).toBe(SHUFFLED_LAYOUT.widgets.find((w) => w.widgetId === "widget-c"))
  })
})

describe("submitComparisonTransaction", () => {
  it("MT-12 AC13: sends exactly one transaction containing the complete mapping", async () => {
    const submit = vi.fn(async () => {})
    const mapping = computeComparisonMapping(SHUFFLED_LAYOUT, CREATOR_IDS, ITEM_IDS)

    const outcome = await submitComparisonTransaction(mapping, submit)

    expect(submit).toHaveBeenCalledTimes(1)
    expect(outcome.committed).toBe(true)
    expect(outcome.layout?.widgets.filter((w) => w.comparison)).toHaveLength(3)
  })

  it("MT-12 AC11: never calls submit when the mapping is not ok", async () => {
    const submit = vi.fn(async () => {})
    const fullLayout: CanonicalLayout = {
      grid: { columns: 1, rows: 1 },
      widgets: [{ widgetId: "widget-a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 }],
    }
    const mapping = computeComparisonMapping(fullLayout, CREATOR_IDS, ["revenue", "engagement"])

    const outcome = await submitComparisonTransaction(mapping, submit)

    expect(submit).not.toHaveBeenCalled()
    expect(outcome.committed).toBe(false)
  })

  it("MT-12 AC19: a rejected transaction commits nothing -- no partial assignment, no appended widget", async () => {
    const submit = vi.fn(async () => {
      throw new Error("network down")
    })
    const twoWidgetLayout: CanonicalLayout = {
      grid: { columns: 2, rows: 2 },
      widgets: [
        { widgetId: "widget-a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
        { widgetId: "widget-b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
      ],
    }
    const mapping = computeComparisonMapping(twoWidgetLayout, CREATOR_IDS, ITEM_IDS) // needs 1 append

    const outcome = await submitComparisonTransaction(mapping, submit)

    expect(outcome.committed).toBe(false)
    expect(outcome.error?.message).toBe("network down")
    expect(outcome.layout).toBeUndefined() // nothing to commit
    // The caller's own canonical state (twoWidgetLayout) was never touched by this call.
    expect(twoWidgetLayout.widgets).toHaveLength(2)
  })

  it("a submitter that mutates its received layout in place cannot corrupt the returned committed layout", async () => {
    const submit = vi.fn(async (received: CanonicalLayout) => {
      received.widgets[0].widgetId = "hijacked"
    })
    const mapping = computeComparisonMapping(SHUFFLED_LAYOUT, CREATOR_IDS, ITEM_IDS)

    const outcome = await submitComparisonTransaction(mapping, submit)

    expect(outcome.layout?.widgets.some((w) => w.widgetId === "hijacked")).toBe(false)
  })
})
