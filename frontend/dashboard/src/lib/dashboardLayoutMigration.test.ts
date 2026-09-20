import { describe, expect, it } from "vitest"
import {
  isCanonicalLayoutShape,
  isLegacyGridPayload,
  LEGACY_MAX_GRID,
  migrateDuplicateWidgetIds,
  proposeLegacyMigration,
  type LegacyGridLayout,
} from "./dashboardLayoutMigration"
import { validateLayout } from "./dashboardLayoutValidation"
import type { CanonicalLayout } from "../types/dashboardLayout"

// MT-15 AC5: a versioned input fixture (this is the v1 legacy shape --
// pre-MT-02 data that could carry a duplicate widgetId, the only kind of
// invalid legacy layout this microtask migrates) and its expected valid
// output after migration.
const LEGACY_FIXTURE_V1_DUPLICATE_WIDGET_ID: CanonicalLayout = {
  grid: { columns: 2, rows: 1 },
  widgets: [
    { widgetId: "dup-id", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "dup-id", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
  ],
}

describe("migrateDuplicateWidgetIds", () => {
  it("MT-15 AC3/AC5: renames every duplicate occurrence after the first to a fresh unique widgetId", () => {
    const migrated = migrateDuplicateWidgetIds(LEGACY_FIXTURE_V1_DUPLICATE_WIDGET_ID)

    // Expected output fixture: first occurrence keeps its original identity...
    expect(migrated.widgets[0].widgetId).toBe("dup-id")
    // ...the later duplicate gets a new, different, non-empty id...
    expect(migrated.widgets[1].widgetId).not.toBe("dup-id")
    expect(migrated.widgets[1].widgetId.length).toBeGreaterThan(0)
    // ...every other field is preserved untouched.
    expect(migrated.widgets[1]).toMatchObject({ widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 })
    // ...and the migrated layout now passes the canonical validator (AC3:
    // "does not render duplicate widgets").
    expect(validateLayout(migrated).valid).toBe(true)
  })

  it("leaves an already-unique layout completely unchanged", () => {
    const layout: CanonicalLayout = {
      grid: { columns: 1, rows: 1 },
      widgets: [{ widgetId: "solo", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 }],
    }
    expect(migrateDuplicateWidgetIds(layout)).toEqual(layout)
  })
})

describe("isCanonicalLayoutShape", () => {
  it("accepts a well-formed canonical layout", () => {
    expect(isCanonicalLayoutShape(LEGACY_FIXTURE_V1_DUPLICATE_WIDGET_ID)).toBe(true)
  })

  it("rejects null, arrays, and primitives", () => {
    expect(isCanonicalLayoutShape(null)).toBe(false)
    expect(isCanonicalLayoutShape([])).toBe(false)
    expect(isCanonicalLayoutShape("not a layout")).toBe(false)
  })

  it("rejects a layout missing required widget fields", () => {
    expect(isCanonicalLayoutShape({ grid: { columns: 2, rows: 2 }, widgets: [{ widgetId: "a" }] })).toBe(false)
  })
})

// GAP-8D: fixtures named by the contract they were saved under
// ("legacy-1x1-5x5"): valid under the former 1x1-5x5 grid contract, invalid
// under the current 1x1-3x3 one only because of grid size.
const w = (widgetId: string, widgetType: string, x: number, y: number, width = 1, height: 0.5 | 1 = 1, extra: object = {}) => ({
  widgetId,
  widgetType,
  x,
  y,
  width,
  height,
  ...extra,
})

const LEGACY_4x2_EIGHT_UNIT_WIDGETS: LegacyGridLayout = {
  grid: { columns: 4, rows: 2 },
  widgets: [
    w("a", "kpi-summary", 0, 0),
    w("b", "ranking", 1, 0),
    w("c", "growth-bar-chart", 2, 0),
    w("d", "contribution-ring", 3, 0, 1, 1, { comparison: { creatorIds: ["c1", "c2"], comparisonItemIds: ["revenue"] }, settings: { color: "teal" } }),
    w("e", "insights", 0, 1),
    w("f", "video-stats-table", 1, 1),
    w("g", "kpi-summary", 2, 1),
    w("h", "ranking", 3, 1),
  ],
}

const LEGACY_4x3_DECLARED_ONLY: LegacyGridLayout = {
  grid: { columns: 4, rows: 3 },
  widgets: [w("a", "kpi-summary", 0, 0), w("b", "ranking", 1, 0), w("c", "insights", 2, 0)],
}

const LEGACY_5x2_TEN_1X_ONLY: LegacyGridLayout = {
  grid: { columns: 5, rows: 2 },
  widgets: Array.from({ length: 10 }, (_, i) => w(`g${i}`, i % 2 ? "growth-bar-chart" : "contribution-ring", i % 5, Math.floor(i / 5))),
}

const LEGACY_4x1_STACKED_HALVES: LegacyGridLayout = {
  grid: { columns: 4, rows: 1 },
  widgets: Array.from({ length: 4 }, (_, i) => [w(`k${i}`, "kpi-summary", i, 0, 1, 0.5), w(`r${i}`, "ranking", i, 0.5, 1, 0.5)]).flat(),
}

const errorsOf = (layout: LegacyGridLayout) => validateLayout(layout as unknown as CanonicalLayout).errors

describe("isLegacyGridPayload (GAP-8D)", () => {
  it("LEGACY_MAX_GRID is the former 5x5 maximum", () => {
    expect(LEGACY_MAX_GRID).toBe(5)
  })

  it.each([
    ["4-column", LEGACY_4x2_EIGHT_UNIT_WIDGETS],
    ["5-column", LEGACY_5x2_TEN_1X_ONLY],
    ["4-column declared-only", LEGACY_4x3_DECLARED_ONLY],
  ])("detects an old-valid %s payload whose only problem is grid size", (_name, layout) => {
    expect(isLegacyGridPayload(layout as unknown as CanonicalLayout, errorsOf(layout))).toBe(true)
  })

  it("detects old-valid rows > 3 (3x4, 3x5) and combined columns and rows > 3", () => {
    for (const grid of [{ columns: 3, rows: 4 }, { columns: 3, rows: 5 }, { columns: 5, rows: 5 }]) {
      const layout: LegacyGridLayout = { grid, widgets: [w("a", "kpi-summary", 0, 0)] }
      expect(isLegacyGridPayload(layout as unknown as CanonicalLayout, errorsOf(layout))).toBe(true)
    }
  })

  it("allows an accompanying DUPLICATE_WIDGET_ID but no other independent corruption", () => {
    const dup: LegacyGridLayout = { grid: { columns: 4, rows: 1 }, widgets: [w("x", "kpi-summary", 0, 0), w("x", "ranking", 1, 0)] }
    expect(isLegacyGridPayload(dup as unknown as CanonicalLayout, errorsOf(dup))).toBe(true)
  })

  it.each([
    ["overlap", { grid: { columns: 4, rows: 2 }, widgets: [w("a", "kpi-summary", 0, 0), w("b", "ranking", 0, 0)] }],
    ["invalid height", { grid: { columns: 4, rows: 2 }, widgets: [w("a", "kpi-summary", 0, 0, 1, 0.75 as 1)] }],
    ["lone 0.5X (incomplete fill)", { grid: { columns: 4, rows: 2 }, widgets: [w("a", "kpi-summary", 0, 0, 1, 0.5)] }],
    ["out of bounds", { grid: { columns: 4, rows: 2 }, widgets: [w("a", "kpi-summary", 4, 0)] }],
    ["fractional x", { grid: { columns: 4, rows: 2 }, widgets: [w("a", "kpi-summary", 0.5, 0)] }],
    ["grid beyond the old range (6x3)", { grid: { columns: 6, rows: 3 }, widgets: [w("a", "kpi-summary", 0, 0)] }],
    ["zero dimension (0x4)", { grid: { columns: 0, rows: 4 }, widgets: [] }],
    ["fractional dimension (2.5x4)", { grid: { columns: 2.5, rows: 4 }, widgets: [] }],
  ] as [string, LegacyGridLayout][])("does not label %s corruption as a legacy grid", (_name, layout) => {
    expect(isLegacyGridPayload(layout as unknown as CanonicalLayout, errorsOf(layout))).toBe(false)
  })

  it("does not treat a current 3x3 layout (no grid error) as legacy", () => {
    const layout: LegacyGridLayout = { grid: { columns: 3, rows: 3 }, widgets: [w("a", "kpi-summary", 0, 0)] }
    expect(isLegacyGridPayload(layout as unknown as CanonicalLayout, errorsOf(layout))).toBe(false)
  })
})

describe("proposeLegacyMigration (GAP-8D)", () => {
  it("a declared-grid-only legacy layout gets a trim proposal with unchanged widget geometry", () => {
    const proposed = proposeLegacyMigration(LEGACY_4x3_DECLARED_ONLY)

    expect(proposed).not.toBeNull()
    expect(proposed!.grid).toEqual({ columns: 3, rows: 3 })
    expect(proposed!.widgets).toEqual(LEGACY_4x3_DECLARED_ONLY.widgets)
    expect(validateLayout(proposed!).valid).toBe(true)
  })

  it("a losslessly repackable old layout produces a fully valid <=3x3 proposal", () => {
    const proposed = proposeLegacyMigration(LEGACY_4x2_EIGHT_UNIT_WIDGETS)

    expect(proposed).not.toBeNull()
    expect(proposed!.grid.columns).toBeLessThanOrEqual(3)
    expect(proposed!.grid.rows).toBeLessThanOrEqual(3)
    expect(validateLayout(proposed!).valid).toBe(true)
  })

  it("preserves widget count, ids, types, heights, array order, comparison config and unknown fields; only geometry may differ", () => {
    const proposed = proposeLegacyMigration(LEGACY_4x2_EIGHT_UNIT_WIDGETS)!

    expect(proposed.widgets).toHaveLength(LEGACY_4x2_EIGHT_UNIT_WIDGETS.widgets.length)
    expect(proposed.widgets.map((x) => x.widgetId)).toEqual(LEGACY_4x2_EIGHT_UNIT_WIDGETS.widgets.map((x) => x.widgetId))
    proposed.widgets.forEach((migrated, i) => {
      const original = LEGACY_4x2_EIGHT_UNIT_WIDGETS.widgets[i]
      expect(migrated.widgetType).toBe(original.widgetType)
      expect(migrated.height).toBe(original.height)
      expect(migrated.comparison).toEqual(original.comparison)
      expect((migrated as unknown as { settings?: unknown }).settings).toEqual((original as unknown as { settings?: unknown }).settings)
    })
  })

  it("keeps deterministic row-major relative order", () => {
    const proposed = proposeLegacyMigration(LEGACY_4x2_EIGHT_UNIT_WIDGETS)!
    const rowMajor = [...proposed.widgets].sort((a, b) => a.y - b.y || a.x - b.x).map((x) => x.widgetId)
    expect(rowMajor).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"])
    expect(proposeLegacyMigration(LEGACY_4x2_EIGHT_UNIT_WIDGETS)).toEqual(proposed)
  })

  it("never mutates its input", () => {
    const before = JSON.stringify(LEGACY_4x2_EIGHT_UNIT_WIDGETS)
    proposeLegacyMigration(LEGACY_4x2_EIGHT_UNIT_WIDGETS)
    expect(JSON.stringify(LEGACY_4x2_EIGHT_UNIT_WIDGETS)).toBe(before)
  })

  it("a stacked 0.5X layout the shelf reflow cannot validly repack returns no proposal", () => {
    expect(validateLayout({ ...LEGACY_4x1_STACKED_HALVES, grid: { columns: 4 as never, rows: 1 } } as unknown as CanonicalLayout).errors.map((e) => e.code)).toEqual(["INVALID_GRID_SIZE"])
    expect(proposeLegacyMigration(LEGACY_4x1_STACKED_HALVES)).toBeNull()
  })

  it("a valid old 5x2 layout with ten 1X-only widgets cannot fit 3x3 without dropping widgets: proposal is null", () => {
    expect(errorsOf(LEGACY_5x2_TEN_1X_ONLY).map((e) => e.code)).toEqual(["INVALID_GRID_SIZE"])
    expect(proposeLegacyMigration(LEGACY_5x2_TEN_1X_ONLY)).toBeNull()
  })

  it("duplicate widgetIds cannot be both preserved and made valid: proposal is null", () => {
    const dup: LegacyGridLayout = { grid: { columns: 4, rows: 1 }, widgets: [w("x", "kpi-summary", 0, 0), w("x", "ranking", 1, 0)] }
    expect(proposeLegacyMigration(dup)).toBeNull()
  })
})
