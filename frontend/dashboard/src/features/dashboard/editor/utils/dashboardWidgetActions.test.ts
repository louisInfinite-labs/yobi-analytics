import { describe, expect, it } from "vitest"
import { addWidget, createWidget, createWidgetId, moveWidget, removeWidget, resizeWidget, updateWidgetGeometry } from "./dashboardWidgetActions"
import type { CanonicalLayout, DashboardWidget } from "../model/dashboardLayout"

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

describe("createWidgetId", () => {
  it("produces a different id on every call, even for the same widgetType", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createWidgetId("kpi-summary")))
    expect(ids.size).toBe(50)
  })

  it("embeds the widgetType for readability", () => {
    expect(createWidgetId("ranking")).toMatch(/^ranking-/)
  })
})

describe("createWidget", () => {
  it("creates two instances with different non-empty widgetId values", () => {
    const a = createWidget("kpi-summary", { x: 0, y: 0, width: 1, height: 1 })
    const b = createWidget("kpi-summary", { x: 1, y: 0, width: 1, height: 1 })
    expect(a.widgetId).not.toBe("")
    expect(b.widgetId).not.toBe("")
    expect(a.widgetId).not.toBe(b.widgetId)
  })
})

describe("addWidget", () => {
  it("commits a valid new widget", () => {
    const base = layout({ widgets: [widget({ widgetId: "a", x: 0, y: 0 })] })
    const outcome = addWidget(base, widget({ widgetId: "b", x: 1, y: 0 }))
    expect(outcome.committed).toBe(true)
    expect(outcome.result.valid).toBe(true)
    expect(outcome.layout.widgets.map((w) => w.widgetId)).toEqual(["a", "b"])
  })

  it("rejects a duplicate widgetId before commit and leaves the input layout untouched", () => {
    const base = layout({ widgets: [widget({ widgetId: "dup", x: 0, y: 0 })] })
    const outcome = addWidget(base, widget({ widgetId: "dup", x: 1, y: 0 }))

    expect(outcome.committed).toBe(false)
    expect(outcome.result.valid).toBe(false)
    expect(outcome.result.errors.map((e) => e.code)).toContain("DUPLICATE_WIDGET_ID")
    // Byte-for-byte unchanged: same reference, not just equal content.
    expect(outcome.layout).toBe(base)
    expect(outcome.layout.widgets).toHaveLength(1)
  })

  it("rejects an invalid placement (e.g. out of bounds) before commit", () => {
    const base = layout({ widgets: [] })
    const outcome = addWidget(base, widget({ widgetId: "off-grid", x: 5, y: 0 }))
    expect(outcome.committed).toBe(false)
    expect(outcome.result.errors.map((e) => e.code)).toContain("OUT_OF_BOUNDS")
    expect(outcome.layout).toBe(base)
  })
})

describe("updateWidgetGeometry", () => {
  it("preserves widgetId and widgetType while moving/resizing", () => {
    const base = layout({ widgets: [widget({ widgetId: "a", widgetType: "ranking", x: 0, y: 0, width: 1, height: 1 })] })
    const outcome = updateWidgetGeometry(base, "a", { x: 1, y: 1 })

    expect(outcome.committed).toBe(true)
    const moved = outcome.layout.widgets[0]
    expect(moved.widgetId).toBe("a")
    expect(moved.widgetType).toBe("ranking")
    expect(moved.x).toBe(1)
    expect(moved.y).toBe(1)
  })

  it("rejects a resize that would overlap another widget and leaves the layout untouched", () => {
    const base = layout({
      widgets: [
        widget({ widgetId: "a", x: 0, y: 0, width: 1, height: 1 }),
        widget({ widgetId: "b", x: 1, y: 0, width: 1, height: 1 }),
      ],
    })
    const outcome = updateWidgetGeometry(base, "a", { width: 2 })

    expect(outcome.committed).toBe(false)
    expect(outcome.result.errors.map((e) => e.code)).toContain("WIDGET_OVERLAP")
    expect(outcome.layout).toBe(base)
  })
})

describe("moveWidget", () => {
  it("imports and consults the canonical validateLayout: a valid move commits and touches only x/y", () => {
    const base = layout({ widgets: [widget({ widgetId: "a", widgetType: "ranking", x: 0, y: 0, width: 1, height: 1 })] })
    const outcome = moveWidget(base, "a", { x: 1, y: 1 })

    expect(outcome.committed).toBe(true)
    const moved = outcome.layout.widgets[0]
    expect(moved.widgetId).toBe("a")
    expect(moved.widgetType).toBe("ranking")
    expect(moved.x).toBe(1)
    expect(moved.y).toBe(1)
    expect(moved.width).toBe(1)
    expect(moved.height).toBe(1)
  })

  it("rejects a move that would overlap another widget and restores the last valid coordinates", () => {
    const base = layout({
      widgets: [
        widget({ widgetId: "a", x: 0, y: 0, width: 1, height: 1 }),
        widget({ widgetId: "b", x: 1, y: 0, width: 1, height: 1 }),
      ],
    })
    const outcome = moveWidget(base, "a", { x: 1, y: 0 })

    expect(outcome.committed).toBe(false)
    expect(outcome.result.errors.map((e) => e.code)).toContain("WIDGET_OVERLAP")
    // Byte-for-byte the same reference the caller passed in -- nothing was
    // ever mutated to roll back from (MT-05 AC11).
    expect(outcome.layout).toBe(base)
    expect(outcome.layout.widgets.find((w) => w.widgetId === "a")).toEqual(base.widgets[0])
  })

  it("rejects a move that would push the widget out of bounds and preserves its widgetId in the unchanged layout", () => {
    const base = layout({ grid: { columns: 2, rows: 2 }, widgets: [widget({ widgetId: "a", x: 0, y: 0 })] })
    const outcome = moveWidget(base, "a", { x: 5, y: 5 })

    expect(outcome.committed).toBe(false)
    expect(outcome.result.errors.map((e) => e.code)).toContain("OUT_OF_BOUNDS")
    expect(outcome.layout).toBe(base)
    expect(outcome.layout.widgets[0].widgetId).toBe("a")
  })
})

describe("resizeWidget", () => {
  it("imports and consults the canonical validateLayout: a valid resize commits and touches only width/height", () => {
    const base = layout({
      grid: { columns: 2, rows: 2 },
      widgets: [widget({ widgetId: "a", widgetType: "ranking", x: 0, y: 0, width: 1, height: 1 })],
    })
    const outcome = resizeWidget(base, "a", { width: 2, height: 1 })

    expect(outcome.committed).toBe(true)
    const resized = outcome.layout.widgets[0]
    expect(resized.widgetId).toBe("a")
    expect(resized.widgetType).toBe("ranking")
    expect(resized.x).toBe(0)
    expect(resized.y).toBe(0)
    expect(resized.width).toBe(2)
  })

  it("rejects a resize that would overlap another widget and restores the last valid size", () => {
    const base = layout({
      widgets: [
        widget({ widgetId: "a", x: 0, y: 0, width: 1, height: 1 }),
        widget({ widgetId: "b", x: 1, y: 0, width: 1, height: 1 }),
      ],
    })
    const outcome = resizeWidget(base, "a", { width: 2, height: 1 })

    expect(outcome.committed).toBe(false)
    expect(outcome.result.errors.map((e) => e.code)).toContain("WIDGET_OVERLAP")
    expect(outcome.layout).toBe(base)
    expect(outcome.layout.widgets.find((w) => w.widgetId === "a")).toEqual(base.widgets[0])
  })

  it("rejects a resize that would leave an incomplete column and preserves widgetId in the unchanged layout", () => {
    const base = layout({ widgets: [widget({ widgetId: "a", x: 0, y: 0, width: 1, height: 1 })] })
    // @ts-expect-error deliberately unsupported height at the type boundary
    const outcome = resizeWidget(base, "a", { width: 1, height: 0.75 })

    expect(outcome.committed).toBe(false)
    expect(outcome.result.errors.map((e) => e.code)).toContain("INVALID_HEIGHT")
    expect(outcome.layout).toBe(base)
    expect(outcome.layout.widgets[0].widgetId).toBe("a")
  })
})

describe("removeWidget", () => {
  it("commits removal and leaves every remaining widget byte-for-byte untouched", () => {
    const remaining = widget({ widgetId: "b", x: 1, y: 0 })
    const base = layout({ widgets: [widget({ widgetId: "a", x: 0, y: 0 }), remaining] })
    const outcome = removeWidget(base, "a")

    expect(outcome.committed).toBe(true)
    expect(outcome.layout.widgets.map((w) => w.widgetId)).toEqual(["b"])
    expect(outcome.layout.widgets[0]).toBe(remaining)
  })

  it("is a no-op commit when widgetId is not present", () => {
    const base = layout({ widgets: [widget({ widgetId: "a", x: 0, y: 0 })] })
    const outcome = removeWidget(base, "does-not-exist")

    expect(outcome.committed).toBe(true)
    expect(outcome.layout.widgets.map((w) => w.widgetId)).toEqual(["a"])
  })

  it("rejects a removal that leaves an incomplete column (one of a stacked 0.5X pair) and leaves the input layout untouched", () => {
    const base = layout({
      widgets: [
        widget({ widgetId: "top", x: 0, y: 0, width: 1, height: 0.5 }),
        widget({ widgetId: "bottom", x: 0, y: 0.5, width: 1, height: 0.5 }),
      ],
    })
    const outcome = removeWidget(base, "top")

    expect(outcome.committed).toBe(false)
    expect(outcome.result.errors.map((e) => e.code)).toContain("INCOMPLETE_COLUMN")
    expect(outcome.layout).toBe(base)
    expect(outcome.layout.widgets).toHaveLength(2)
  })
})

describe("GAP-2E: per-widget-type height capability enforcement", () => {
  describe("addWidget", () => {
    it("rejects growth-bar-chart at 0.5X and leaves the input layout untouched", () => {
      const base = layout({ widgets: [] })
      const outcome = addWidget(base, widget({ widgetId: "a", widgetType: "growth-bar-chart", x: 0, y: 0, width: 1, height: 0.5 }))

      expect(outcome.committed).toBe(false)
      expect(outcome.result.errors.map((e) => e.code)).toContain("INVALID_HEIGHT")
      expect(outcome.layout).toBe(base)
    })

    it("rejects contribution-ring at 0.5X and leaves the input layout untouched", () => {
      const base = layout({ widgets: [] })
      const outcome = addWidget(base, widget({ widgetId: "a", widgetType: "contribution-ring", x: 0, y: 0, width: 1, height: 0.5 }))

      expect(outcome.committed).toBe(false)
      expect(outcome.result.errors.map((e) => e.code)).toContain("INVALID_HEIGHT")
      expect(outcome.layout).toBe(base)
    })

    it.each(["growth-bar-chart", "contribution-ring"])("commits %s at 1X", (widgetType) => {
      const base = layout({ widgets: [] })
      const outcome = addWidget(base, widget({ widgetId: "a", widgetType, x: 0, y: 0, width: 1, height: 1 }))

      expect(outcome.committed).toBe(true)
    })

    it.each(["kpi-summary", "ranking", "insights", "video-stats-table"])(
      "commits %s stacked at 0.5X (paired to fill the column) and standalone at 1X",
      (widgetType) => {
        const base = layout({ widgets: [widget({ widgetId: "top-half", widgetType, x: 0, y: 0, width: 1, height: 0.5 })] })
        const outcomeHalf = addWidget(base, widget({ widgetId: "bottom-half", widgetType, x: 0, y: 0.5, width: 1, height: 0.5 }))
        expect(outcomeHalf.committed).toBe(true)

        const outcomeFull = addWidget(layout({ widgets: [] }), widget({ widgetId: "full", widgetType, x: 0, y: 0, width: 1, height: 1 }))
        expect(outcomeFull.committed).toBe(true)
      },
    )

    it("does not restrict an unregistered widgetType (e.g. the comparison widget type)", () => {
      const base = layout({
        widgets: [widget({ widgetId: "top-half", widgetType: "creator-comparison-chart", x: 0, y: 0, width: 1, height: 0.5 })],
      })
      const outcome = addWidget(base, widget({ widgetId: "bottom-half", widgetType: "creator-comparison-chart", x: 0, y: 0.5, width: 1, height: 0.5 }))

      expect(outcome.committed).toBe(true)
    })
  })

  describe("updateWidgetGeometry / resizeWidget", () => {
    it("rejects resizing growth-bar-chart down to 0.5X, preserving widgetId and the prior geometry", () => {
      const base = layout({ widgets: [widget({ widgetId: "a", widgetType: "growth-bar-chart", x: 0, y: 0, width: 1, height: 1 })] })
      const outcome = resizeWidget(base, "a", { width: 1, height: 0.5 })

      expect(outcome.committed).toBe(false)
      expect(outcome.result.errors.map((e) => e.code)).toContain("INVALID_HEIGHT")
      expect(outcome.layout).toBe(base)
      expect(outcome.layout.widgets.find((w) => w.widgetId === "a")).toEqual(base.widgets[0])
    })

    it("rejects resizing contribution-ring down to 0.5X, preserving widgetId and the prior geometry", () => {
      const base = layout({ widgets: [widget({ widgetId: "a", widgetType: "contribution-ring", x: 0, y: 0, width: 1, height: 1 })] })
      const outcome = resizeWidget(base, "a", { width: 1, height: 0.5 })

      expect(outcome.committed).toBe(false)
      expect(outcome.result.errors.map((e) => e.code)).toContain("INVALID_HEIGHT")
      expect(outcome.layout).toBe(base)
      expect(outcome.layout.widgets.find((w) => w.widgetId === "a")).toEqual(base.widgets[0])
    })

    it("commits resizing ranking between 0.5X and 1X in both directions", () => {
      // "a" starts full-height and "b" already occupies the bottom half slot
      // it will shrink into -- overlapping until the resize below lands "a"
      // in the top half, completing the stacked pair. Only the post-resize
      // candidate is ever validated (never this base state on its own).
      const toHalf = updateWidgetGeometry(
        layout({
          widgets: [
            widget({ widgetId: "a", widgetType: "ranking", x: 0, y: 0, width: 1, height: 1 }),
            widget({ widgetId: "b", widgetType: "ranking", x: 0, y: 0.5, width: 1, height: 0.5 }),
          ],
        }),
        "a",
        { height: 0.5 },
      )
      expect(toHalf.committed).toBe(true)

      const toFull = updateWidgetGeometry(
        layout({ widgets: [widget({ widgetId: "a", widgetType: "ranking", x: 0, y: 0, width: 1, height: 0.5 })] }),
        "a",
        { height: 1 },
      )
      expect(toFull.committed).toBe(true)
    })

    it("a move (x/y only) on growth-bar-chart at its existing 1X height still commits", () => {
      const base = layout({ widgets: [widget({ widgetId: "a", widgetType: "growth-bar-chart", x: 0, y: 0, width: 1, height: 1 })] })
      const outcome = moveWidget(base, "a", { x: 1, y: 1 })

      expect(outcome.committed).toBe(true)
    })
  })
})

describe("widgetId survives a save/reload round trip", () => {
  it("preserves the complete ordered widgetId list through JSON serialize + parse", () => {
    let current = layout({ widgets: [] })
    current = addWidget(current, createWidget("kpi-summary", { x: 0, y: 0, width: 1, height: 1 })).layout
    current = addWidget(current, createWidget("ranking", { x: 1, y: 0, width: 1, height: 1 })).layout
    current = addWidget(current, createWidget("insights", { x: 0, y: 1, width: 2, height: 1 })).layout

    const idsBeforeReload = current.widgets.map((w) => w.widgetId)

    const reloaded: CanonicalLayout = JSON.parse(JSON.stringify(current))
    const idsAfterReload = reloaded.widgets.map((w) => w.widgetId)

    expect(idsAfterReload).toEqual(idsBeforeReload)
    expect(new Set(idsAfterReload).size).toBe(idsAfterReload.length)
  })
})
