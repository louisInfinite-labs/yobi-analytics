import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ComparisonWidget } from "./ComparisonWidget"
import { mockCreators } from "../data/mockCreators"
import { COMPARISON_WIDGET_TYPE } from "../lib/dashboardComparisonWidgets"
import type { DashboardWidget } from "../types/dashboardLayout"
import type { ComparisonDataRequest, ComparisonDataResponse } from "../types/dashboardComparisonData"

const ITEMS = [
  { comparisonItemId: "daily-view-growth", label: "Daily view growth" },
  { comparisonItemId: "total-views", label: "Total views" },
]

function widget(creatorIds: string[], comparisonItemIds: string[] = ["daily-view-growth"]): DashboardWidget {
  return { widgetId: "w1", widgetType: COMPARISON_WIDGET_TYPE, x: 0, y: 0, width: 1, height: 1, comparison: { creatorIds, comparisonItemIds } }
}

const okFor = (request: ComparisonDataRequest): ComparisonDataResponse => ({
  creators: request.creatorIds.map((creatorId) => ({ status: "ok" as const, creatorId, points: [{ label: "Mon", value: 1 }] })),
})

beforeEach(() => {
  // jsdom computes no layout: give the measured chart area a real size.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 200, width: 500, height: 200, toJSON: () => ({}) })
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
})

describe("ComparisonWidget (GAP-9)", () => {
  it("lists the configured creators in exactly config order with numbered, labelled order badges", () => {
    const ids = ["ch_kiryu_coco", "ch_gawr_gura", "ch_iofi"]
    render(<ComparisonWidget widget={widget(ids)} roster={mockCreators} availableComparisonItems={ITEMS} fetchComparisonData={() => new Promise(() => undefined)} />)

    const list = screen.getByRole("list", { name: "Comparison creators in order" })
    const items = within(list).getAllByRole("listitem")
    expect(items.map((item) => item.getAttribute("data-creator-id"))).toEqual(ids)
    expect(items.map((item) => item.querySelector(".comparison-widget__creator-name")?.textContent)).toEqual(["桐生ココ", "Gawr Gura", "Airani Iofifteen"])
    expect(within(list).getAllByLabelText(/Comparison order/).map((badge) => badge.getAttribute("aria-label"))).toEqual(["Comparison order 1", "Comparison order 2", "Comparison order 3"])
    expect(items.map((item) => item.querySelector(".comparison-order-badge")?.textContent)).toEqual(["1", "2", "3"])
  })

  it("sends the configured creator order and only the widget's item in the request", async () => {
    const ids = ["ch_kiryu_coco", "ch_gawr_gura", "ch_iofi"]
    const fetchComparisonData = vi.fn((request: ComparisonDataRequest) => Promise.resolve(okFor(request)))
    render(<ComparisonWidget widget={widget(ids, ["total-views"])} roster={mockCreators} availableComparisonItems={ITEMS} fetchComparisonData={fetchComparisonData} />)

    await waitFor(() => expect(fetchComparisonData).toHaveBeenCalled())
    expect(fetchComparisonData).toHaveBeenCalledWith({ creatorIds: ids, comparisonItemIds: ["total-views"] })
  })

  it("shows Select Creators only when a handler is supplied, and reports the widget id", async () => {
    const user = userEvent.setup()
    const onSelectCreators = vi.fn()
    const { rerender } = render(<ComparisonWidget widget={widget(["ch_gawr_gura"])} roster={mockCreators} availableComparisonItems={ITEMS} fetchComparisonData={() => new Promise(() => undefined)} />)
    expect(screen.queryByRole("button", { name: "Select Creators" })).not.toBeInTheDocument()

    rerender(<ComparisonWidget widget={widget(["ch_gawr_gura"])} roster={mockCreators} availableComparisonItems={ITEMS} fetchComparisonData={() => new Promise(() => undefined)} onSelectCreators={onSelectCreators} />)
    await user.click(screen.getByRole("button", { name: "Select Creators" }))
    expect(onSelectCreators).toHaveBeenCalledWith("w1")
  })

  it("keeps the creator list and shows the loading container while the request is pending", () => {
    render(<ComparisonWidget widget={widget(["ch_gawr_gura", "ch_iofi"])} roster={mockCreators} availableComparisonItems={ITEMS} fetchComparisonData={() => new Promise(() => undefined)} />)
    expect(screen.getByTestId("comparison-chart-loading")).toBeInTheDocument()
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
  })

  it("keeps the full configuration after a failed request", async () => {
    render(<ComparisonWidget widget={widget(["ch_gawr_gura", "ch_iofi"])} roster={mockCreators} availableComparisonItems={ITEMS} fetchComparisonData={() => Promise.reject(new Error("boom"))} />)
    expect(await screen.findByTestId("comparison-chart-error")).toBeInTheDocument()
    expect(screen.getAllByRole("listitem").map((item) => item.getAttribute("data-creator-id"))).toEqual(["ch_gawr_gura", "ch_iofi"])
  })

  it("an unavailable creator stays in the list and is reported actionably while the others still chart", async () => {
    const fetchComparisonData = vi.fn(() =>
      Promise.resolve<ComparisonDataResponse>({
        creators: [
          { status: "ok", creatorId: "ch_gawr_gura", points: [{ label: "Mon", value: 1 }] },
          { status: "unavailable", creatorId: "ch_kiryu_coco" },
        ],
      }),
    )
    render(<ComparisonWidget widget={widget(["ch_gawr_gura", "ch_kiryu_coco"])} roster={mockCreators} availableComparisonItems={ITEMS} fetchComparisonData={fetchComparisonData} />)

    expect(await screen.findByTestId("comparison-chart-issue-ch_kiryu_coco")).toHaveTextContent("No longer available for comparison.")
    const list = screen.getByRole("list", { name: "Comparison creators in order" })
    expect(within(list).getAllByRole("listitem").map((item) => item.getAttribute("data-creator-id"))).toEqual(["ch_gawr_gura", "ch_kiryu_coco"])
  })

  it("keeps an id that is not in the roster (display falls back to the id) instead of dropping it", () => {
    render(<ComparisonWidget widget={widget(["ch_gawr_gura", "ch_unknown"])} roster={mockCreators} availableComparisonItems={ITEMS} fetchComparisonData={() => new Promise(() => undefined)} />)
    expect(screen.getAllByRole("listitem").map((item) => item.getAttribute("data-creator-id"))).toEqual(["ch_gawr_gura", "ch_unknown"])
    expect(screen.getByText("ch_unknown")).toBeInTheDocument()
  })

  it("explains an unconfigured widget instead of requesting anything", () => {
    const fetchComparisonData = vi.fn()
    render(<ComparisonWidget widget={{ ...widget([]), comparison: undefined }} roster={mockCreators} availableComparisonItems={ITEMS} fetchComparisonData={fetchComparisonData} />)
    expect(screen.getByTestId("comparison-widget-unconfigured")).toHaveTextContent("No creators selected yet.")
    expect(fetchComparisonData).not.toHaveBeenCalled()
  })
})
