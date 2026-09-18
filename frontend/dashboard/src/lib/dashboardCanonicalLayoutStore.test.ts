import { describe, expect, it, vi } from "vitest"
import { createLocalCanonicalLayoutSubmit, readCanonicalLayout, writeCanonicalLayout } from "./dashboardCanonicalLayoutStore"
import { submitLayoutSave } from "./dashboardLayoutSave"
import * as dashboardLayoutValidation from "./dashboardLayoutValidation"
import type { CanonicalLayout } from "../types/dashboardLayout"

function memoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}

const VALID_LAYOUT: CanonicalLayout = {
  grid: { columns: 2, rows: 1 },
  widgets: [
    { widgetId: "widget-a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "widget-b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
  ],
}

const OVERLAPPING_LAYOUT_RAW = JSON.stringify({
  grid: { columns: 1, rows: 1 },
  widgets: [
    { widgetId: "widget-a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "widget-b", widgetType: "ranking", x: 0, y: 0, width: 1, height: 1 },
  ],
})

const DUPLICATE_ID_LAYOUT_RAW = JSON.stringify({
  grid: { columns: 2, rows: 1 },
  widgets: [
    { widgetId: "dup-id", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "dup-id", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
  ],
})

describe("readCanonicalLayout", () => {
  it("MT-15 AC2: the production load path imports and calls the canonical validateLayout", () => {
    const spy = vi.spyOn(dashboardLayoutValidation, "validateLayout")
    const storage = memoryStorage()
    storage.setItem("yobi-analytics-canonical-dashboard-layout", JSON.stringify(VALID_LAYOUT))

    readCanonicalLayout(storage)

    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it("returns an empty result when nothing has been saved yet", () => {
    expect(readCanonicalLayout(memoryStorage())).toEqual({ status: "empty" })
  })

  it("MT-15 AC1: a valid save survives a fresh read with a deep-equal layout (reload)", () => {
    const storage = memoryStorage()
    writeCanonicalLayout(VALID_LAYOUT, storage)

    // A fresh `readCanonicalLayout` call against the same storage stands in
    // for a full page reload -- no in-memory state is reused between calls.
    const reloaded = readCanonicalLayout(storage)

    expect(reloaded).toEqual({ status: "valid", layout: VALID_LAYOUT })
  })

  it("MT-17 AC8: ordered creatorIds on a comparison widget survive the same save/reload path as widget geometry", () => {
    const storage = memoryStorage()
    const layoutWithComparison: CanonicalLayout = {
      grid: { columns: 1, rows: 1 },
      widgets: [
        {
          widgetId: "comparison-widget",
          widgetType: "creator-comparison-chart",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          comparison: { creatorIds: ["creator-a", "creator-b", "creator-c"], comparisonItemIds: ["revenue"] },
        },
      ],
    }
    writeCanonicalLayout(layoutWithComparison, storage)

    const reloaded = readCanonicalLayout(storage)

    expect(reloaded).toEqual({ status: "valid", layout: layoutWithComparison })
    if (reloaded.status !== "valid") throw new Error("unreachable")
    expect(reloaded.layout.widgets[0].comparison?.creatorIds).toEqual(["creator-a", "creator-b", "creator-c"])
  })

  it("MT-15 AC3: duplicate-ID legacy data loads as a migrated layout with no duplicate widgets", () => {
    const storage = memoryStorage()
    storage.setItem("yobi-analytics-canonical-dashboard-layout", DUPLICATE_ID_LAYOUT_RAW)

    const result = readCanonicalLayout(storage)

    expect(result.status).toBe("valid")
    if (result.status !== "valid") throw new Error("unreachable")
    const ids = result.layout.widgets.map((widget) => widget.widgetId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("MT-15 AC4/AC6: overlapping legacy data is not silently rendered -- it enters a recoverable error state", () => {
    const storage = memoryStorage()
    storage.setItem("yobi-analytics-canonical-dashboard-layout", OVERLAPPING_LAYOUT_RAW)

    const result = readCanonicalLayout(storage)

    expect(result.status).toBe("error")
  })

  it("MT-15 AC6: corrupt JSON is also a recoverable error, never a thrown exception", () => {
    const storage = memoryStorage()
    storage.setItem("yobi-analytics-canonical-dashboard-layout", "{not json")

    expect(() => readCanonicalLayout(storage)).not.toThrow()
    expect(readCanonicalLayout(storage).status).toBe("error")
  })

  it("MT-15 AC7: recovering from invalid data never deletes or rewrites the stored value", () => {
    const storage = memoryStorage()
    storage.setItem("yobi-analytics-canonical-dashboard-layout", OVERLAPPING_LAYOUT_RAW)

    readCanonicalLayout(storage)

    expect(storage.getItem("yobi-analytics-canonical-dashboard-layout")).toBe(OVERLAPPING_LAYOUT_RAW)
  })
})

describe("createLocalCanonicalLayoutSubmit + submitLayoutSave", () => {
  it("MT-15 AC8: a failed save leaves the last persisted canonical layout in place", async () => {
    const storage = memoryStorage()
    writeCanonicalLayout(VALID_LAYOUT, storage)

    const failingSubmit = createLocalCanonicalLayoutSubmit({
      ...storage,
      setItem: () => {
        throw new Error("storage quota exceeded")
      },
    })

    const draft: CanonicalLayout = {
      grid: { columns: 2, rows: 1 },
      widgets: [
        { widgetId: "widget-a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
        { widgetId: "widget-c", widgetType: "insights", x: 1, y: 0, width: 1, height: 1 },
      ],
    }
    const outcome = await submitLayoutSave(draft, failingSubmit)

    expect(outcome.committed).toBe(false)
    // The original storage (never touched by the failing submit above) still
    // reflects the last successfully persisted layout, unchanged.
    expect(readCanonicalLayout(storage)).toEqual({ status: "valid", layout: VALID_LAYOUT })
  })

  it("a successful save round-trips through the real store", async () => {
    const storage = memoryStorage()
    const outcome = await submitLayoutSave(VALID_LAYOUT, createLocalCanonicalLayoutSubmit(storage))

    expect(outcome.committed).toBe(true)
    expect(readCanonicalLayout(storage)).toEqual({ status: "valid", layout: VALID_LAYOUT })
  })
})
