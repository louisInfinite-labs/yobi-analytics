import { describe, expect, it, vi } from "vitest"
import {
  convertLegacyLayout,
  createLocalCanonicalLayoutSubmit,
  LEGACY_LAYOUT_BACKUP_STORAGE_KEY,
  loadCanonicalLayoutState,
  loadInitialCanonicalLayout,
  readCanonicalLayout,
  writeCanonicalLayout,
} from "./dashboardCanonicalLayoutStore"
import { submitLayoutSave } from "../utils/dashboardLayoutSave"
import * as dashboardLayoutValidation from "../utils/dashboardLayoutValidation"
import { validateLayout } from "../utils/dashboardLayoutValidation"
import type { CanonicalLayout } from "../model/dashboardLayout"

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

// GAP-8D: legacy (pre-3x3) recovery. Fixtures named by contract: valid under
// the former 1x1-5x5 grid, invalid now only because of grid size.
const KEY = "yobi-analytics-canonical-dashboard-layout"
const unit = (widgetId: string, widgetType: string, x: number, y: number, extra: object = {}) => ({ widgetId, widgetType, x, y, width: 1, height: 1, ...extra })

const LEGACY_4x2_RAW = JSON.stringify({
  grid: { columns: 4, rows: 2 },
  widgets: [
    unit("a", "kpi-summary", 0, 0),
    unit("b", "ranking", 1, 0),
    unit("c", "growth-bar-chart", 2, 0),
    unit("d", "contribution-ring", 3, 0, { comparison: { creatorIds: ["c1", "c2"], comparisonItemIds: ["revenue"] } }),
    unit("e", "insights", 0, 1),
    unit("f", "video-stats-table", 1, 1),
  ],
})
const LEGACY_5x1_RAW = JSON.stringify({ grid: { columns: 5, rows: 1 }, widgets: [0, 1, 2, 3, 4].map((i) => unit(`w${i}`, "kpi-summary", i, 0)) })
const LEGACY_4x3_TRIM_RAW = JSON.stringify({ grid: { columns: 4, rows: 3 }, widgets: [unit("a", "kpi-summary", 0, 0), unit("b", "ranking", 1, 0)] })
const LEGACY_5x2_UNMIGRATABLE_RAW = JSON.stringify({
  grid: { columns: 5, rows: 2 },
  widgets: Array.from({ length: 10 }, (_, i) => unit(`g${i}`, i % 2 ? "growth-bar-chart" : "contribution-ring", i % 5, Math.floor(i / 5))),
})

function seeded(raw: string): Storage {
  const storage = memoryStorage()
  storage.setItem(KEY, raw)
  return storage
}

describe("legacy 4/5-grid recovery (GAP-8D)", () => {
  it("an old 4-column payload is a legacy-grid result, never an ordinary valid layout", () => {
    const result = readCanonicalLayout(seeded(LEGACY_4x2_RAW))
    expect(result.status).toBe("legacy-grid")
    if (result.status !== "legacy-grid") throw new Error("unreachable")
    expect(result.raw).toBe(LEGACY_4x2_RAW)
    expect(result.parsed.grid).toEqual({ columns: 4, rows: 2 })
  })

  it("an old 5-column payload is a legacy-grid result", () => {
    expect(readCanonicalLayout(seeded(LEGACY_5x1_RAW)).status).toBe("legacy-grid")
  })

  it("loading legacy data writes nothing: the primary value is byte-identical and no backup exists", () => {
    const storage = seeded(LEGACY_4x2_RAW)
    const setItem = vi.spyOn(storage, "setItem")
    const removeItem = vi.spyOn(storage, "removeItem")

    readCanonicalLayout(storage)
    loadInitialCanonicalLayout(storage)
    loadCanonicalLayoutState(storage)

    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
    expect(storage.getItem(KEY)).toBe(LEGACY_4x2_RAW)
    expect(storage.getItem(LEGACY_LAYOUT_BACKUP_STORAGE_KEY)).toBeNull()
  })

  it("loadCanonicalLayoutState exposes the recovery and only the in-memory default 2x2 as the layout", () => {
    const state = loadCanonicalLayoutState(seeded(LEGACY_4x2_RAW))
    expect(state.legacy?.raw).toBe(LEGACY_4x2_RAW)
    expect(state.layout.grid).toEqual({ columns: 2, rows: 2 })
  })

  it("a trivial declared-grid trim yields a proposal but persists nothing until Convert", () => {
    const storage = seeded(LEGACY_4x3_TRIM_RAW)
    const result = readCanonicalLayout(storage)
    if (result.status !== "legacy-grid") throw new Error("expected legacy-grid")

    expect(result.proposed).not.toBeNull()
    expect(result.proposed!.grid).toEqual({ columns: 3, rows: 3 })
    expect(storage.getItem(KEY)).toBe(LEGACY_4x3_TRIM_RAW)
  })

  it("a losslessly repackable old layout yields a valid <=3x3 proposal with identical ids and config", () => {
    const result = readCanonicalLayout(seeded(LEGACY_4x2_RAW))
    if (result.status !== "legacy-grid") throw new Error("expected legacy-grid")

    expect(result.proposed).not.toBeNull()
    expect(validateLayout(result.proposed!).valid).toBe(true)
    expect(result.proposed!.widgets.map((x) => x.widgetId)).toEqual(result.parsed.widgets.map((x) => x.widgetId))
    expect(result.proposed!.widgets.find((x) => x.widgetId === "d")?.comparison).toEqual({ creatorIds: ["c1", "c2"], comparisonItemIds: ["revenue"] })
  })

  it("an old 5x2 layout with ten 1X-only widgets is legacy with proposed = null", () => {
    const result = readCanonicalLayout(seeded(LEGACY_5x2_UNMIGRATABLE_RAW))
    expect(result.status).toBe("legacy-grid")
    if (result.status !== "legacy-grid") throw new Error("unreachable")
    expect(result.proposed).toBeNull()
  })

  it.each([
    ["overlapping 4x2", JSON.stringify({ grid: { columns: 4, rows: 2 }, widgets: [unit("a", "kpi-summary", 0, 0), unit("b", "ranking", 0, 0)] })],
    ["invalid-height 4x2", JSON.stringify({ grid: { columns: 4, rows: 2 }, widgets: [{ ...unit("a", "kpi-summary", 0, 0), height: 0.75 }] })],
    ["out-of-old-range 6x3", JSON.stringify({ grid: { columns: 6, rows: 3 }, widgets: [unit("a", "kpi-summary", 0, 0)] })],
  ])("ordinary corrupt data (%s) is a plain error, not a legacy migration", (_name, raw) => {
    expect(readCanonicalLayout(seeded(raw)).status).toBe("error")
  })

  it("legacy data that also has duplicate ids is legacy with no proposal (ids cannot be both preserved and unique)", () => {
    const raw = JSON.stringify({ grid: { columns: 4, rows: 1 }, widgets: [unit("x", "kpi-summary", 0, 0), unit("x", "ranking", 1, 0)] })
    const result = readCanonicalLayout(seeded(raw))
    expect(result.status).toBe("legacy-grid")
    if (result.status !== "legacy-grid") throw new Error("unreachable")
    expect(result.proposed).toBeNull()
  })

  it("the existing duplicate-ID migration on a current-size layout does not regress", () => {
    const result = readCanonicalLayout(seeded(DUPLICATE_ID_LAYOUT_RAW))
    expect(result.status).toBe("valid")
  })

  describe("normal Save protection", () => {
    it("a normal save rejects while a legacy payload is stored and leaves it byte-identical", async () => {
      const storage = seeded(LEGACY_4x2_RAW)
      const submit = createLocalCanonicalLayoutSubmit(storage)

      await expect(submit(VALID_LAYOUT)).rejects.toThrow(/awaiting conversion/)
      expect(storage.getItem(KEY)).toBe(LEGACY_4x2_RAW)
    })

    it("still saves normally when the stored payload is not legacy", async () => {
      const storage = seeded(JSON.stringify(VALID_LAYOUT))
      await createLocalCanonicalLayoutSubmit(storage)({ ...VALID_LAYOUT, grid: { columns: 2, rows: 1 } })
      expect(readCanonicalLayout(storage).status).toBe("valid")
    })
  })

  describe("convertLegacyLayout", () => {
    function recoveryOf(storage: Storage) {
      const result = readCanonicalLayout(storage)
      if (result.status !== "legacy-grid") throw new Error("expected legacy-grid")
      return { raw: result.raw, parsed: result.parsed, proposed: result.proposed }
    }

    it("writes the backup first, verifies it, and only then writes the primary", () => {
      const storage = seeded(LEGACY_4x2_RAW)
      const order: string[] = []
      const realSet = storage.setItem.bind(storage)
      const realGet = storage.getItem.bind(storage)
      vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
        order.push(`set:${key === KEY ? "primary" : "backup"}`)
        realSet(key, value)
      })
      vi.spyOn(storage, "getItem").mockImplementation((key) => {
        order.push(`get:${key === KEY ? "primary" : "backup"}`)
        return realGet(key)
      })

      expect(convertLegacyLayout(recoveryOf(seeded(LEGACY_4x2_RAW)), storage)).toEqual({ ok: true })

      expect(order.indexOf("set:backup")).toBeGreaterThan(-1)
      expect(order.indexOf("set:backup")).toBeLessThan(order.indexOf("set:primary"))
      const verifyReadAfterBackup = order.slice(order.indexOf("set:backup") + 1).indexOf("get:backup")
      expect(verifyReadAfterBackup).toBeGreaterThan(-1)
      expect(order.slice(order.indexOf("set:backup") + 1).indexOf("get:backup")).toBeLessThan(order.slice(order.indexOf("set:backup") + 1).indexOf("set:primary"))
    })

    it("the backup holds the exact original raw payload and the primary becomes a normal valid <=3x3 layout", () => {
      const storage = seeded(LEGACY_4x2_RAW)
      expect(convertLegacyLayout(recoveryOf(storage), storage)).toEqual({ ok: true })

      expect(storage.getItem(LEGACY_LAYOUT_BACKUP_STORAGE_KEY)).toBe(LEGACY_4x2_RAW)
      const reloaded = readCanonicalLayout(storage)
      expect(reloaded.status).toBe("valid")
      if (reloaded.status !== "valid") throw new Error("unreachable")
      expect(reloaded.layout.grid.columns).toBeLessThanOrEqual(3)
      expect(reloaded.layout.widgets.map((x) => x.widgetId).sort()).toEqual(["a", "b", "c", "d", "e", "f"])
    })

    it("a backup write failure leaves the primary byte-identical", () => {
      const storage = seeded(LEGACY_4x2_RAW)
      const recovery = recoveryOf(storage)
      const realSet = storage.setItem.bind(storage)
      vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
        if (key === LEGACY_LAYOUT_BACKUP_STORAGE_KEY) throw new Error("quota")
        realSet(key, value)
      })

      const result = convertLegacyLayout(recovery, storage)

      expect(result.ok).toBe(false)
      expect(storage.getItem(KEY)).toBe(LEGACY_4x2_RAW)
    })

    it("a backup that cannot be read back verifies as failed and leaves the primary byte-identical", () => {
      const storage = seeded(LEGACY_4x2_RAW)
      const recovery = recoveryOf(storage)
      const realSet = storage.setItem.bind(storage)
      vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
        if (key === LEGACY_LAYOUT_BACKUP_STORAGE_KEY) return // silently dropped
        realSet(key, value)
      })

      const result = convertLegacyLayout(recovery, storage)

      expect(result.ok).toBe(false)
      expect(storage.getItem(KEY)).toBe(LEGACY_4x2_RAW)
    })

    it("refuses when the layout has no proposal", () => {
      const storage = seeded(LEGACY_5x2_UNMIGRATABLE_RAW)
      const result = convertLegacyLayout(recoveryOf(storage), storage)
      expect(result.ok).toBe(false)
      expect(storage.getItem(KEY)).toBe(LEGACY_5x2_UNMIGRATABLE_RAW)
      expect(storage.getItem(LEGACY_LAYOUT_BACKUP_STORAGE_KEY)).toBeNull()
    })

    it("refuses when the primary changed since it was loaded, and never overwrites a different existing backup", () => {
      const storage = seeded(LEGACY_4x2_RAW)
      const recovery = recoveryOf(storage)

      storage.setItem(KEY, LEGACY_5x1_RAW)
      expect(convertLegacyLayout(recovery, storage).ok).toBe(false)
      expect(storage.getItem(KEY)).toBe(LEGACY_5x1_RAW)

      storage.setItem(KEY, LEGACY_4x2_RAW)
      storage.setItem(LEGACY_LAYOUT_BACKUP_STORAGE_KEY, "an earlier backup")
      expect(convertLegacyLayout(recovery, storage).ok).toBe(false)
      expect(storage.getItem(LEGACY_LAYOUT_BACKUP_STORAGE_KEY)).toBe("an earlier backup")
      expect(storage.getItem(KEY)).toBe(LEGACY_4x2_RAW)
    })

    it("a failed primary write after a verified backup reports failure and keeps the backup", () => {
      const storage = seeded(LEGACY_4x2_RAW)
      const recovery = recoveryOf(storage)
      const realSet = storage.setItem.bind(storage)
      vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
        if (key === KEY) throw new Error("quota")
        realSet(key, value)
      })

      expect(convertLegacyLayout(recovery, storage).ok).toBe(false)
      expect(storage.getItem(KEY)).toBe(LEGACY_4x2_RAW)
      expect(storage.getItem(LEGACY_LAYOUT_BACKUP_STORAGE_KEY)).toBe(LEGACY_4x2_RAW)
    })
  })
})
