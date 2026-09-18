import { describe, expect, it } from "vitest"
import { isCanonicalLayoutShape, migrateDuplicateWidgetIds } from "./dashboardLayoutMigration"
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
