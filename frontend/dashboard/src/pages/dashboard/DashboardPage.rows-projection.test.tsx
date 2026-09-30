import { render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemberThemeProvider } from "../../shared/theme/MemberThemeProvider"
import { DashboardPage } from "./DashboardPage"
import type { ChartCatalogItem } from "../../features/dashboard/catalog/model/dashboardChartCatalog"

/** CodeRabbit PR #61 follow-up finding: DashboardPage passed
 * `layoutForDisplay.grid.rows` (the pre-reflow canonical row count) to
 * DashboardGrid's `rows` prop instead of `projection.rows`. A reflow to
 * fewer columns (`reflowLayoutForBreakpoint`, see dashboardResponsive.ts)
 * routinely needs MORE rows than the source canonical layout -- e.g. three
 * 1x1 widgets in a 3-column, 1-row layout become three separate shelves (3
 * rows) once forced into mobile's single column. Passing the smaller,
 * pre-reflow value under-sizes GridStack's `maxRow`, which can clip or
 * overlap the reflowed widgets.
 *
 * DashboardGrid itself is stubbed here: this test's only job is proving
 * DashboardPage computes and passes the correct (post-reflow) `rows` value
 * -- that GridStack/maxRow/slot-guides then honor whatever `rows` value
 * they're given is already covered by DashboardGrid.test.tsx's own
 * portal-preservation and column-change tests (CodeRabbit PR #61, finding
 * 1). jsdom does no real layout, so a visual clipping/overlap assertion
 * isn't meaningfully testable at this level regardless. */
vi.mock("../../features/dashboard/editor/components/DashboardGrid", () => ({
  DashboardGrid: (props: { rows: number; columns: number; widgets: unknown[] }) => (
    <div data-testid="dashboard-grid-stub" data-rows={props.rows} data-columns={props.columns} data-widget-count={props.widgets.length} />
  ),
}))

const KEY = "yobi-analytics-canonical-dashboard-layout"
const catalogFetcher = (items: ChartCatalogItem[] = []) => vi.fn(() => Promise.resolve(items.map((item) => ({ ...item }))))

// Three 1x1 widgets side by side in a 3-column, 1-row canonical layout --
// forcing a single-column (mobile) reflow stacks them into 3 separate rows.
const LAYOUT_RAW = JSON.stringify({
  grid: { columns: 3, rows: 1 },
  widgets: [
    { widgetId: "a", widgetType: "subscriber-leaderboard", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "b", widgetType: "creator-video-ranking", x: 1, y: 0, width: 1, height: 1 },
    { widgetId: "c", widgetType: "subscriber-leaderboard", x: 2, y: 0, width: 1, height: 1 },
  ],
})

const originalInnerWidth = window.innerWidth

afterEach(() => {
  window.localStorage.clear()
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth })
})

function renderAtWidth(width: number) {
  window.localStorage.setItem(KEY, LAYOUT_RAW)
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
  return render(
    <MemberThemeProvider>
      <DashboardPage fetchCatalog={catalogFetcher()} />
    </MemberThemeProvider>,
  )
}

describe("DashboardPage row/column projection wiring (CodeRabbit PR #61 follow-up)", () => {
  it("passes the post-reflow row count to DashboardGrid when mobile reflow needs more rows than the canonical layout", async () => {
    renderAtWidth(375) // < 768: mobile, unconditionally reflowed to 1 column
    const stub = await waitFor(() => screen.getByTestId("dashboard-grid-stub"))

    expect(stub).toHaveAttribute("data-columns", "1")
    // 3 canonical rows -- NOT the canonical layout's own `grid.rows` (1).
    expect(stub).toHaveAttribute("data-rows", "3")
    expect(stub).toHaveAttribute("data-widget-count", "3")
  })

  it("still passes the canonical row count unchanged when no reflow is needed (desktop, layout already fits)", async () => {
    renderAtWidth(1280) // desktop, 3 columns already fits the 3-column cap
    const stub = await waitFor(() => screen.getByTestId("dashboard-grid-stub"))

    expect(stub).toHaveAttribute("data-columns", "3")
    expect(stub).toHaveAttribute("data-rows", "1")
    expect(stub).toHaveAttribute("data-widget-count", "3")
  })
})
