import { describe, expect, it } from "vitest"
import {
  isGridDimension,
  isWidgetHeight,
  type CanonicalLayout,
  type CreatorComparisonConfig,
  type DashboardWidget,
} from "../types/dashboardLayout"
import { validateLayout } from "./dashboardLayoutValidation"

function widget(overrides: Partial<DashboardWidget> = {}): DashboardWidget {
  return {
    widgetId: "widget-a",
    widgetType: "kpi-summary",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    ...overrides,
  }
}

function layout(overrides: Partial<CanonicalLayout> = {}): CanonicalLayout {
  return {
    grid: { columns: 2, rows: 2 },
    widgets: [],
    ...overrides,
  }
}

function codesOf(result: ReturnType<typeof validateLayout>): string[] {
  return result.errors.map((error) => error.code)
}

describe("isGridDimension", () => {
  it.each([1, 2, 3, 4, 5])("accepts %i", (value) => {
    expect(isGridDimension(value)).toBe(true)
  })

  it.each([0, 6, -1, 2.5, 3.1, NaN])("rejects %s", (value) => {
    expect(isGridDimension(value)).toBe(false)
  })
})

describe("isWidgetHeight", () => {
  it.each([0.5, 1])("accepts %s", (value) => {
    expect(isWidgetHeight(value)).toBe(true)
  })

  it.each([0, 0.25, 0.75, 1.25, 2])("rejects %s", (value) => {
    expect(isWidgetHeight(value)).toBe(false)
  })
})

describe("validateLayout — grid size", () => {
  it.each([
    [1, 1],
    [5, 5],
    [3, 2],
  ])("accepts a %ix%i grid", (columns, rows) => {
    const result = validateLayout(layout({ grid: { columns: columns as 1 | 5 | 3, rows: rows as 1 | 5 | 2 } }))
    expect(codesOf(result)).not.toContain("INVALID_GRID_SIZE")
  })

  it.each([
    [0, 3],
    [6, 5],
  ])("rejects a %ix%i grid as INVALID_GRID_SIZE", (columns, rows) => {
    // @ts-expect-error deliberately out-of-range at the type boundary
    const result = validateLayout(layout({ grid: { columns, rows } }))
    expect(codesOf(result)).toContain("INVALID_GRID_SIZE")
    expect(result.valid).toBe(false)
  })

  it("rejects a non-integer grid dimension as INVALID_GRID_SIZE", () => {
    // @ts-expect-error deliberately non-integer at the type boundary
    const result = validateLayout(layout({ grid: { columns: 2.5, rows: 4 } }))
    expect(codesOf(result)).toContain("INVALID_GRID_SIZE")
  })
})

describe("validateLayout — widget identity", () => {
  it("requires widgetId and widgetType on every widget (compile-time contract)", () => {
    const instance: DashboardWidget = widget({ widgetId: "widget-1", widgetType: "kpi-summary" })
    expect(instance.widgetId).toBe("widget-1")
    expect(instance.widgetType).toBe("kpi-summary")
  })

  it("flags a duplicate widgetId as DUPLICATE_WIDGET_ID", () => {
    const result = validateLayout(
      layout({
        widgets: [
          widget({ widgetId: "dup", x: 0, y: 0 }),
          widget({ widgetId: "dup", x: 1, y: 1 }),
        ],
      }),
    )
    expect(codesOf(result)).toContain("DUPLICATE_WIDGET_ID")
    expect(result.errors.find((e) => e.code === "DUPLICATE_WIDGET_ID")?.widgetIds).toEqual(["dup"])
    expect(result.valid).toBe(false)
  })

  it("accepts distinct widgetId values sharing the same widgetType", () => {
    const result = validateLayout(
      layout({
        widgets: [
          widget({ widgetId: "a", widgetType: "ranking", x: 0, y: 0 }),
          widget({ widgetId: "b", widgetType: "ranking", x: 1, y: 0 }),
        ],
      }),
    )
    expect(codesOf(result)).not.toContain("DUPLICATE_WIDGET_ID")
  })
})

describe("validateLayout — widget height", () => {
  it.each([0.5, 1])("accepts height %s", (height) => {
    const result = validateLayout(layout({ widgets: [widget({ height: height as 0.5 | 1 })] }))
    expect(codesOf(result)).not.toContain("INVALID_HEIGHT")
  })

  it.each([0.25, 0.75, 1.25])("rejects height %s as INVALID_HEIGHT", (height) => {
    // @ts-expect-error deliberately unsupported height at the type boundary
    const result = validateLayout(layout({ widgets: [widget({ height })] }))
    expect(codesOf(result)).toContain("INVALID_HEIGHT")
    expect(result.valid).toBe(false)
  })
})

describe("validateLayout — widget width", () => {
  it("accepts a width within the active grid", () => {
    const result = validateLayout(layout({ grid: { columns: 3, rows: 1 }, widgets: [widget({ width: 3 })] }))
    expect(codesOf(result)).not.toContain("INVALID_WIDTH")
  })

  it("rejects a width wider than the active grid as INVALID_WIDTH", () => {
    const result = validateLayout(layout({ grid: { columns: 2, rows: 2 }, widgets: [widget({ width: 3 })] }))
    expect(codesOf(result)).toContain("INVALID_WIDTH")
  })

  it("rejects a non-integer width as INVALID_WIDTH", () => {
    const result = validateLayout(layout({ widgets: [widget({ width: 1.5 })] }))
    expect(codesOf(result)).toContain("INVALID_WIDTH")
  })
})

describe("validateLayout — bounds", () => {
  it("rejects a widget extending past the grid as OUT_OF_BOUNDS", () => {
    const result = validateLayout(
      layout({ grid: { columns: 2, rows: 2 }, widgets: [widget({ x: 1, y: 0, width: 2, height: 1 })] }),
    )
    expect(codesOf(result)).toContain("OUT_OF_BOUNDS")
  })

  it("rejects a negative coordinate as OUT_OF_BOUNDS", () => {
    const result = validateLayout(layout({ widgets: [widget({ x: -1, y: 0 })] }))
    expect(codesOf(result)).toContain("OUT_OF_BOUNDS")
  })

  it("accepts a widget flush against the grid edge", () => {
    const result = validateLayout(layout({ grid: { columns: 2, rows: 2 }, widgets: [widget({ x: 1, y: 1, width: 1, height: 1 })] }))
    expect(codesOf(result)).not.toContain("OUT_OF_BOUNDS")
  })
})

describe("validateLayout — coordinate finiteness and grid-unit alignment", () => {
  it("rejects x = NaN as OUT_OF_BOUNDS", () => {
    const result = validateLayout(layout({ widgets: [widget({ x: NaN })] }))
    expect(codesOf(result)).toContain("OUT_OF_BOUNDS")
    expect(result.valid).toBe(false)
  })

  it("rejects y = NaN as OUT_OF_BOUNDS", () => {
    const result = validateLayout(layout({ widgets: [widget({ y: NaN })] }))
    expect(codesOf(result)).toContain("OUT_OF_BOUNDS")
  })

  it.each([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects x = %s as OUT_OF_BOUNDS", (value) => {
    const result = validateLayout(layout({ widgets: [widget({ x: value })] }))
    expect(codesOf(result)).toContain("OUT_OF_BOUNDS")
  })

  it.each([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects y = %s as OUT_OF_BOUNDS", (value) => {
    const result = validateLayout(layout({ widgets: [widget({ y: value })] }))
    expect(codesOf(result)).toContain("OUT_OF_BOUNDS")
  })

  it("rejects a fractional x as OUT_OF_BOUNDS", () => {
    const result = validateLayout(layout({ widgets: [widget({ x: 0.5 })] }))
    expect(codesOf(result)).toContain("OUT_OF_BOUNDS")
  })

  it("rejects a quarter-row y as OUT_OF_BOUNDS", () => {
    const result = validateLayout(layout({ widgets: [widget({ y: 0.25 })] }))
    expect(codesOf(result)).toContain("OUT_OF_BOUNDS")
  })

  it("accepts a half-row y for a 0.5X widget", () => {
    const result = validateLayout(layout({ widgets: [widget({ y: 0.5, height: 0.5 })] }))
    expect(codesOf(result)).not.toContain("OUT_OF_BOUNDS")
  })

  it("accepts an integer y for a 0.5X widget", () => {
    const result = validateLayout(layout({ widgets: [widget({ y: 1, height: 0.5 })] }))
    expect(codesOf(result)).not.toContain("OUT_OF_BOUNDS")
  })

  it("accepts an integer y for a 1X widget", () => {
    const result = validateLayout(layout({ widgets: [widget({ y: 1, height: 1 })] }))
    expect(codesOf(result)).not.toContain("OUT_OF_BOUNDS")
  })

  it("rejects a 1X widget starting at y = 0.5 as OUT_OF_BOUNDS", () => {
    const result = validateLayout(layout({ widgets: [widget({ y: 0.5, height: 1 })] }))
    expect(codesOf(result)).toContain("OUT_OF_BOUNDS")
    expect(result.valid).toBe(false)
  })

  it("does not hang when width is also non-finite alongside an invalid coordinate", () => {
    const result = validateLayout(layout({ widgets: [widget({ x: Number.POSITIVE_INFINITY, width: Number.POSITIVE_INFINITY })] }))
    expect(codesOf(result)).toContain("OUT_OF_BOUNDS")
  })
})

describe("validateLayout — collisions", () => {
  it("flags two overlapping widgets as WIDGET_OVERLAP", () => {
    const result = validateLayout(
      layout({
        widgets: [
          widget({ widgetId: "a", x: 0, y: 0, width: 2, height: 1 }),
          widget({ widgetId: "b", x: 1, y: 0, width: 1, height: 1 }),
        ],
      }),
    )
    expect(codesOf(result)).toContain("WIDGET_OVERLAP")
    expect(result.errors.find((e) => e.code === "WIDGET_OVERLAP")?.widgetIds?.sort()).toEqual(["a", "b"])
  })

  it("accepts adjacent, non-overlapping widgets", () => {
    const result = validateLayout(
      layout({
        widgets: [
          widget({ widgetId: "a", x: 0, y: 0, width: 1, height: 1 }),
          widget({ widgetId: "b", x: 1, y: 0, width: 1, height: 1 }),
        ],
      }),
    )
    expect(codesOf(result)).not.toContain("WIDGET_OVERLAP")
  })
})

describe("validateLayout — column fill", () => {
  it("accepts one full-height 1X widget filling a column", () => {
    const result = validateLayout(layout({ widgets: [widget({ height: 1 })] }))
    expect(codesOf(result)).not.toContain("INCOMPLETE_COLUMN")
  })

  it("accepts two stacked 0.5X widgets filling a column", () => {
    const result = validateLayout(
      layout({
        widgets: [
          widget({ widgetId: "top", x: 0, y: 0, width: 1, height: 0.5 }),
          widget({ widgetId: "bottom", x: 0, y: 0.5, width: 1, height: 0.5 }),
        ],
      }),
    )
    expect(codesOf(result)).not.toContain("INCOMPLETE_COLUMN")
  })

  it("flags a lone 0.5X widget as INCOMPLETE_COLUMN", () => {
    const result = validateLayout(layout({ widgets: [widget({ height: 0.5 })] }))
    expect(codesOf(result)).toContain("INCOMPLETE_COLUMN")
    expect(result.valid).toBe(false)
  })
})

describe("CreatorComparisonConfig", () => {
  it("requires ordered creatorIds and comparisonItemIds (compile-time contract)", () => {
    const config: CreatorComparisonConfig = {
      creatorIds: ["creator-a", "creator-b"],
      comparisonItemIds: ["revenue"],
    }
    expect(config.creatorIds).toEqual(["creator-a", "creator-b"])
    expect(config.comparisonItemIds).toEqual(["revenue"])

    // @ts-expect-error creatorIds is required
    const missingCreatorIds: CreatorComparisonConfig = { comparisonItemIds: ["revenue"] }
    // @ts-expect-error comparisonItemIds is required
    const missingComparisonItemIds: CreatorComparisonConfig = { creatorIds: ["creator-a", "creator-b"] }
    expect(missingCreatorIds).toBeDefined()
    expect(missingComparisonItemIds).toBeDefined()
  })
})

describe("validateLayout — the initial 2x2 fixture", () => {
  it("passes validation with no errors", () => {
    const result = validateLayout({
      grid: { columns: 2, rows: 2 },
      widgets: [
        widget({ widgetId: "A", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 }),
        widget({ widgetId: "B", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 }),
        widget({ widgetId: "C", widgetType: "insights", x: 0, y: 1, width: 1, height: 1 }),
        widget({ widgetId: "D", widgetType: "contribution-ring", x: 1, y: 1, width: 1, height: 1 }),
      ],
    })
    expect(result).toEqual({ valid: true, errors: [] })
  })
})
