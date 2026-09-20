/** MT-06 "Exact 16px Spacing" -- DOM-rendered geometry evidence.
 *
 * jsdom (this project's `vitest` `environment`, src/test/setup.ts) has no
 * real layout engine: `Element.getBoundingClientRect()` always returns an
 * all-zero rect regardless of any CSS applied, and no Playwright/browser
 * runner is configured in this repository. To still produce genuine
 * `getBoundingClientRect()`-based evidence rather than a fabricated
 * expectation, every element under test here is positioned with explicit
 * inline pixel `left`/`top`/`width`/`height` styles computed by the single
 * canonical `computeWidgetPixelRect` (./dashboardSpacing.ts) -- the same
 * function a real component would use -- and `getBoundingClientRect` is
 * overridden for the duration of this file to sum each element's own
 * inline `left`/`top` up its ancestor chain, exactly mirroring what a real
 * browser would report for elements positioned this way. This proves the
 * geometry *contract* (the arithmetic, and that a component applying it
 * produces the required rects); it is not a substitute for a real
 * cross-browser/breakpoint visual pass, which remains unverified in this
 * environment (AGENTS.md Section 24).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import {
  computeWidgetPixelRect,
  widgetToComponentContribution,
  type EdgeContributionsPx,
  type GridPixelConfig,
  type WidgetGeometry,
} from "./dashboardSpacing"

const GRID: GridPixelConfig = { columnWidthPx: 320, rowHeightPx: 240 }

function pixelStyleValue(el: HTMLElement, prop: "left" | "top"): number {
  const parsed = parseFloat(el.style[prop])
  return Number.isFinite(parsed) ? parsed : 0
}

/** Sums each element's own inline left/top up to (not including) `document.body`
 * -- see the file docstring for why this replaces jsdom's real (absent) layout. */
function computeAbsoluteRect(el: HTMLElement): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
  let left = 0
  let top = 0
  for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
    left += pixelStyleValue(node, "left")
    top += pixelStyleValue(node, "top")
  }
  const width = parseFloat(el.style.width) || 0
  const height = parseFloat(el.style.height) || 0
  return { left, top, width, height, right: left + width, bottom: top + height }
}

let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect

beforeAll(() => {
  originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return computeAbsoluteRect(this) as DOMRect
  }
})

afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
})

/** Renders one widget's own border-box using the canonical geometry
 * function -- the same box a saved widget, a drag placeholder, or an
 * insertion placeholder all share (Section 5.3). `editMode` adds the
 * dashed-guide overlay described by Section 5.3's "Editor guide and
 * preview geometry" rules: an inset overlay that must add no margin,
 * padding, width, or height of its own. */
function WidgetBox({
  widget,
  grid,
  edges,
  editMode,
  testId = "widget-box",
}: {
  widget: WidgetGeometry & { widgetId: string }
  grid: GridPixelConfig
  edges?: EdgeContributionsPx
  editMode?: boolean
  testId?: string
}) {
  const rect = computeWidgetPixelRect(widget, grid, edges)
  return (
    <div
      data-testid={testId}
      data-widget-id={widget.widgetId}
      style={{ position: "absolute", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, boxSizing: "border-box" }}
    >
      {editMode && (
        <div
          data-testid="edit-guide"
          style={{ position: "absolute", left: "0px", top: "0px", width: `${rect.width}px`, height: `${rect.height}px`, boxSizing: "border-box", border: "1px dashed" }}
        />
      )}
    </div>
  )
}

/** A non-widget neighboring block with an explicit, known rect -- standing
 * in for "the layout owner must know the spacing contribution of both
 * sides" (Section 5.3), since this fixture never reads a real component's
 * computed styles at runtime (the guidelines explicitly forbid that). */
function NeighborComponent({ left, top, width, height }: { left: number; top: number; width: number; height: number }) {
  return (
    <div
      data-testid="neighbor-component"
      style={{ position: "absolute", left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` }}
    />
  )
}

describe("MT-06 — widget-to-widget spacing (rendered)", () => {
  it("horizontal adjacent widgets measure exactly 16px apart via getBoundingClientRect (AC2)", () => {
    render(
      <>
        <WidgetBox widget={{ widgetId: "left", x: 0, y: 0, width: 1, height: 1 }} grid={GRID} testId="left-box" />
        <WidgetBox widget={{ widgetId: "right", x: 1, y: 0, width: 1, height: 1 }} grid={GRID} testId="right-box" />
      </>,
    )
    const leftRect = screen.getByTestId("left-box").getBoundingClientRect()
    const rightRect = screen.getByTestId("right-box").getBoundingClientRect()
    expect(rightRect.left - leftRect.right).toBe(16)
  })

  it("vertical adjacent widgets measure exactly 16px apart via getBoundingClientRect (AC3)", () => {
    render(
      <>
        <WidgetBox widget={{ widgetId: "upper", x: 0, y: 0, width: 1, height: 1 }} grid={GRID} testId="upper-box" />
        <WidgetBox widget={{ widgetId: "lower", x: 0, y: 1, width: 1, height: 1 }} grid={GRID} testId="lower-box" />
      </>,
    )
    const upperRect = screen.getByTestId("upper-box").getBoundingClientRect()
    const lowerRect = screen.getByTestId("lower-box").getBoundingClientRect()
    expect(lowerRect.top - upperRect.bottom).toBe(16)
  })

  it("no adjacent pair measures 32px (AC4)", () => {
    render(
      <>
        <WidgetBox widget={{ widgetId: "left", x: 0, y: 0, width: 1, height: 1 }} grid={GRID} testId="left-box" />
        <WidgetBox widget={{ widgetId: "right", x: 1, y: 0, width: 1, height: 1 }} grid={GRID} testId="right-box" />
      </>,
    )
    const leftRect = screen.getByTestId("left-box").getBoundingClientRect()
    const rightRect = screen.getByTestId("right-box").getBoundingClientRect()
    expect(rightRect.left - leftRect.right).not.toBe(32)
  })
})

describe("MT-06 — widget-to-component spacing (rendered, AC5-7)", () => {
  it("fixture A: a 0px-contributing neighbor still measures exactly 16px from the widget", () => {
    // The neighbor's own contribution is 0px, so its rendered box's right
    // edge sits exactly at the widget's raw cell origin (x=0 -> 0px).
    const componentContribution = 0
    const edges: EdgeContributionsPx = { top: 8, right: 8, bottom: 8, left: widgetToComponentContribution(componentContribution) }
    render(
      <>
        <NeighborComponent left={-100} top={0} width={100} height={240} />
        <WidgetBox widget={{ widgetId: "a", x: 0, y: 0, width: 1, height: 1 }} grid={{ columnWidthPx: 320, rowHeightPx: 240 }} edges={edges} />
      </>,
    )
    const widgetRect = screen.getByTestId("widget-box").getBoundingClientRect()
    const neighborRect = screen.getByTestId("neighbor-component").getBoundingClientRect()
    expect(widgetRect.left - neighborRect.right).toBe(16)
  })

  it("fixture B: an 8px-contributing neighbor still measures exactly 16px from the widget", () => {
    // The neighbor's own contribution is 8px, so its rendered box's right
    // edge sits 8px short of the widget's raw cell origin (x=0 -> 0px).
    const componentContribution = 8
    const edges: EdgeContributionsPx = { top: 8, right: 8, bottom: 8, left: widgetToComponentContribution(componentContribution) }
    render(
      <>
        <NeighborComponent left={-108} top={0} width={100} height={240} />
        <WidgetBox widget={{ widgetId: "a", x: 0, y: 0, width: 1, height: 1 }} grid={{ columnWidthPx: 320, rowHeightPx: 240 }} edges={edges} />
      </>,
    )
    const widgetRect = screen.getByTestId("widget-box").getBoundingClientRect()
    const neighborRect = screen.getByTestId("neighbor-component").getBoundingClientRect()
    expect(widgetRect.left - neighborRect.right).toBe(16)
  })

  it("never produces a doubled 32px gap by applying a plain 16px on both sides", () => {
    const edges: EdgeContributionsPx = { top: 8, right: 8, bottom: 8, left: widgetToComponentContribution(8) }
    render(
      <>
        <NeighborComponent left={-108} top={0} width={100} height={240} />
        <WidgetBox widget={{ widgetId: "a", x: 0, y: 0, width: 1, height: 1 }} grid={{ columnWidthPx: 320, rowHeightPx: 240 }} edges={edges} />
      </>,
    )
    const widgetRect = screen.getByTestId("widget-box").getBoundingClientRect()
    const neighborRect = screen.getByTestId("neighbor-component").getBoundingClientRect()
    expect(widgetRect.left - neighborRect.right).not.toBe(32)
  })
})

describe("MT-06 — drag placeholder vs saved widget (AC8)", () => {
  it("a drag placeholder and a saved widget at the same target produce identical rects", () => {
    const target = { widgetId: "target", x: 1, y: 0, width: 1, height: 1 } as const
    render(
      <>
        <WidgetBox widget={target} grid={GRID} testId="drag-placeholder" />
        <WidgetBox widget={target} grid={GRID} testId="saved-widget" />
      </>,
    )
    // Both boxes are produced by the same computeWidgetPixelRect call for the
    // same target -- this proves the shared-calculation contract, not a live
    // pointer-driven drag session (GAP-4, unowned by MT-06).
    expect(screen.getByTestId("drag-placeholder").getBoundingClientRect()).toEqual(
      screen.getByTestId("saved-widget").getBoundingClientRect(),
    )
  })
})

describe("MT-06 — dashed edit guide geometry neutrality (AC10-13)", () => {
  const widget = { widgetId: "a", x: 0, y: 0, width: 1, height: 1 } as const

  it("enabling the dashed edit guide changes no widget rect value (AC10)", () => {
    const { unmount } = render(<WidgetBox widget={widget} grid={GRID} />)
    const viewModeRect = screen.getByTestId("widget-box").getBoundingClientRect()
    unmount()

    render(<WidgetBox widget={widget} grid={GRID} editMode />)
    const editModeRect = screen.getByTestId("widget-box").getBoundingClientRect()

    expect(editModeRect).toEqual(viewModeRect)
  })

  it("the guide itself contributes 0px additional geometry: its rect equals the widget's own rect (AC11)", () => {
    render(<WidgetBox widget={widget} grid={GRID} editMode />)
    const widgetRect = screen.getByTestId("widget-box").getBoundingClientRect()
    const guideRect = screen.getByTestId("edit-guide").getBoundingClientRect()
    expect(guideRect).toEqual(widgetRect)
  })

  it("the 16px neighbor gap is unchanged with the guide enabled (AC12)", () => {
    render(
      <>
        <WidgetBox widget={{ widgetId: "left", x: 0, y: 0, width: 1, height: 1 }} grid={GRID} editMode testId="left-box" />
        <WidgetBox widget={{ widgetId: "right", x: 1, y: 0, width: 1, height: 1 }} grid={GRID} editMode testId="right-box" />
      </>,
    )
    const leftRect = screen.getByTestId("left-box").getBoundingClientRect()
    const rightRect = screen.getByTestId("right-box").getBoundingClientRect()
    expect(rightRect.left - leftRect.right).toBe(16)
  })

  it("an unchanged edit preview and the saved view-mode widget have identical rects (AC13)", () => {
    const { unmount } = render(<WidgetBox widget={widget} grid={GRID} />)
    const savedViewRect = screen.getByTestId("widget-box").getBoundingClientRect()
    unmount()

    render(<WidgetBox widget={widget} grid={GRID} editMode testId="widget-box" />)
    const editPreviewRect = screen.getByTestId("widget-box").getBoundingClientRect()

    expect(editPreviewRect).toEqual(savedViewRect)
  })
})

describe("MT-06 — insertion placeholder vs resulting widget (AC14)", () => {
  it("an insertion placeholder and the widget produced by dropping into it have identical rects", () => {
    const target = { widgetId: "e", x: 2, y: 0, width: 1, height: 1 } as const
    render(
      <>
        <WidgetBox widget={target} grid={GRID} testId="insertion-placeholder" />
        <WidgetBox widget={target} grid={GRID} testId="resulting-widget" />
      </>,
    )
    // Both boxes come from the same target geometry through the same
    // function -- this proves the border-box contract, not a real
    // insertion-slot drag interaction (MT-08's concern).
    expect(screen.getByTestId("insertion-placeholder").getBoundingClientRect()).toEqual(
      screen.getByTestId("resulting-widget").getBoundingClientRect(),
    )
  })
})
