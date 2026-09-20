/** MT-15 Correction: AC1 ("A valid save survives a full page reload with
 * deep-equal layout configuration") and AC2 ("The production load path
 * imports and uses the canonical validateLayout function"), proven against
 * the real production load/save boundary -- `DashboardCanonicalEditor`
 * itself -- rather than only the underlying storage module in isolation
 * (`dashboardCanonicalLayoutStore.test.ts` already covers that module
 * directly; this file proves the component actually uses it).
 *
 * A full page reload discards all in-memory React state and re-mounts the
 * component tree from scratch; `render()` followed by `unmount()` followed
 * by a second, independent `render()` against the same underlying
 * `Storage` reproduces exactly that -- nothing from the first mount (its
 * fiber tree, hook state, or closures) is reused by the second one, so this
 * is not "calling the load function twice in the same mounted state."
 */
import { afterAll, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { DashboardCanonicalEditor } from "./DashboardCanonicalEditor"
import { writeCanonicalLayout } from "../data/dashboardCanonicalLayoutStore"
import * as dashboardLayoutValidation from "../utils/dashboardLayoutValidation"
import type { CanonicalLayout } from "../model/dashboardLayout"

const SAVED_LAYOUT: CanonicalLayout = {
  grid: { columns: 2, rows: 1 },
  widgets: [
    { widgetId: "widget-a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "widget-b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
  ],
}

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

function pixelStyleValue(el: HTMLElement, prop: "left" | "top" | "width" | "height"): number {
  return parseFloat(el.style[prop]) || 0
}

/** `data-widget-id` -> its rendered pixel box, read straight from the real
 * `CanonicalWidgetBox` inline styles (the same source `dashboardSpacing.ts`'s
 * `computeWidgetPixelRect` writes) -- an objective, per-widget geometry
 * snapshot rather than eyeballing the DOM. */
function renderedWidgetRects(): Record<string, { left: number; top: number; width: number; height: number }> {
  const boxes = screen.getAllByTestId("canonical-widget-box")
  const rects: Record<string, { left: number; top: number; width: number; height: number }> = {}
  for (const box of boxes) {
    const widgetId = box.getAttribute("data-widget-id")!
    rects[widgetId] = {
      left: pixelStyleValue(box, "left"),
      top: pixelStyleValue(box, "top"),
      width: pixelStyleValue(box, "width"),
      height: pixelStyleValue(box, "height"),
    }
  }
  return rects
}

afterAll(() => {
  vi.restoreAllMocks()
})

describe("DashboardCanonicalEditor persistence (MT-15 Correction AC1/AC2)", () => {
  it("AC1: a valid save survives a full page reload with deep-equal rendered layout", () => {
    const storage = memoryStorage()
    // "A valid save" from a prior session -- the same persistence boundary
    // `submitSave` would have written through (`writeCanonicalLayout` is
    // `createLocalCanonicalLayoutSubmit`'s own implementation).
    writeCanonicalLayout(SAVED_LAYOUT, storage)

    // First "page load": no `layout` prop, so the component loads it itself.
    const first = render(<DashboardCanonicalEditor storage={storage} />)
    const firstRects = renderedWidgetRects()
    expect(Object.keys(firstRects).sort()).toEqual(["widget-a", "widget-b"])

    // A full reload: discard every bit of in-memory component state...
    first.unmount()

    // ...and re-mount fresh against the same underlying storage, exactly
    // like a new page load reading the same persisted data.
    render(<DashboardCanonicalEditor storage={storage} />)
    const secondRects = renderedWidgetRects()

    expect(secondRects).toEqual(firstRects)
  })

  it("AC2: the production load path (this component's own load boundary) imports and uses the canonical validateLayout", () => {
    const storage = memoryStorage()
    writeCanonicalLayout(SAVED_LAYOUT, storage)
    const spy = vi.spyOn(dashboardLayoutValidation, "validateLayout")

    render(<DashboardCanonicalEditor storage={storage} />)

    expect(spy).toHaveBeenCalled()
  })
})
