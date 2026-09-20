import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ComparisonChart } from "./ComparisonChart"
import { MIN_CHART_WIDTH_PX } from "../../editor/utils/dashboardResponsive"
import type { MockCreator } from "../../../../entities/creator/data/mockCreators"
import type { ComparisonDataResponse } from "../model/dashboardComparisonData"
import type { ComparisonItem } from "../model/dashboardComparisonCatalog"

function creator(channelId: string, channelName: string): MockCreator {
  return { channelId, channelName, organization: "vspo", branch: "vspo_jp", groupKey: [], channelType: "member", lifecycleStage: "active" }
}

const CREATOR_A = creator("creator-a", "Creator A")
const CREATOR_B = creator("creator-b", "Creator B")
const CREATOR_C = creator("creator-c", "Creator C")

const AVAILABLE_ITEMS: ComparisonItem[] = [
  { comparisonItemId: "revenue", label: "Revenue" },
  { comparisonItemId: "engagement", label: "Engagement" },
  { comparisonItemId: "growth", label: "Growth" },
]

function pending<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

describe("ComparisonChart", () => {
  it("MT-14 AC5: loading state renders from the creators/item props, before any fetch resolves", () => {
    const fetchComparisonData = vi.fn(() => pending<ComparisonDataResponse>())
    render(<ComparisonChart creators={[CREATOR_A, CREATOR_B]} comparisonItemId="revenue" availableComparisonItems={AVAILABLE_ITEMS} width={400} height={200} fetchComparisonData={fetchComparisonData} />)

    const loading = screen.getByTestId("comparison-chart-loading")
    expect(loading).toBeInTheDocument()
    expect(loading.getAttribute("aria-label")).toBe("Loading comparison for Creator A, Creator B")
  })

  it("MT-14 AC1/AC2: requests ordered, deduplicated creatorIds and comparisonItemIds", () => {
    const fetchComparisonData = vi.fn(() => pending<ComparisonDataResponse>())
    render(<ComparisonChart creators={[CREATOR_A, CREATOR_B, CREATOR_A]} comparisonItemId="revenue" availableComparisonItems={AVAILABLE_ITEMS} width={400} height={200} fetchComparisonData={fetchComparisonData} />)

    expect(fetchComparisonData).toHaveBeenCalledWith({ creatorIds: ["creator-a", "creator-b"], comparisonItemIds: ["revenue"] })
  })

  it("MT-14 AC2: a comparisonItemId absent from availableComparisonItems never reaches the outgoing request", () => {
    const fetchComparisonData = vi.fn(() => pending<ComparisonDataResponse>())
    render(
      <ComparisonChart
        creators={[CREATOR_A, CREATOR_B]}
        comparisonItemId="not-a-real-item"
        availableComparisonItems={AVAILABLE_ITEMS}
        width={400}
        height={200}
        fetchComparisonData={fetchComparisonData}
      />,
    )

    expect(fetchComparisonData).toHaveBeenCalledWith({ creatorIds: ["creator-a", "creator-b"], comparisonItemIds: [] })
  })

  it("MT-14 AC3/AC4: renders one series per creator, legend order matching creator click order", async () => {
    const fetchComparisonData = vi.fn(() =>
      Promise.resolve<ComparisonDataResponse>({
        creators: [
          { status: "ok", creatorId: "creator-a", points: [{ label: "Mon", value: 10 }] },
          { status: "ok", creatorId: "creator-b", points: [{ label: "Mon", value: 20 }] },
          { status: "ok", creatorId: "creator-c", points: [{ label: "Mon", value: 30 }] },
        ],
      }),
    )
    render(
      <ComparisonChart creators={[CREATOR_A, CREATOR_B, CREATOR_C]} comparisonItemId="revenue" availableComparisonItems={AVAILABLE_ITEMS} width={400} height={200} fetchComparisonData={fetchComparisonData} />,
    )

    await waitFor(() => expect(screen.getByTestId("comparison-chart")).toBeInTheDocument())

    const legendItems = document.querySelectorAll(".recharts-legend-item-text")
    expect(Array.from(legendItems).map((el) => el.textContent)).toEqual(["Creator A", "Creator B", "Creator C"])

    const lines = document.querySelectorAll(".recharts-line")
    expect(lines.length).toBe(3)
  })

  it("MT-16 AC5: below the minimum readable width, the chart does not render — a fallback shows instead", async () => {
    const fetchComparisonData = vi.fn(() =>
      Promise.resolve<ComparisonDataResponse>({
        creators: [{ status: "ok", creatorId: "creator-a", points: [{ label: "Mon", value: 10 }] }],
      }),
    )
    render(
      <ComparisonChart
        creators={[CREATOR_A]}
        comparisonItemId="revenue"
        availableComparisonItems={AVAILABLE_ITEMS}
        width={MIN_CHART_WIDTH_PX - 1}
        height={200}
        fetchComparisonData={fetchComparisonData}
      />,
    )

    await screen.findByTestId("comparison-chart-too-narrow")
    expect(document.querySelectorAll(".recharts-line").length).toBe(0)
  })

  it("MT-16 AC5: at or above the minimum readable width, the chart renders normally", async () => {
    const fetchComparisonData = vi.fn(() =>
      Promise.resolve<ComparisonDataResponse>({
        creators: [{ status: "ok", creatorId: "creator-a", points: [{ label: "Mon", value: 10 }] }],
      }),
    )
    render(
      <ComparisonChart
        creators={[CREATOR_A]}
        comparisonItemId="revenue"
        availableComparisonItems={AVAILABLE_ITEMS}
        width={MIN_CHART_WIDTH_PX}
        height={200}
        fetchComparisonData={fetchComparisonData}
      />,
    )

    await waitFor(() => expect(document.querySelectorAll(".recharts-line").length).toBe(1))
    expect(screen.queryByTestId("comparison-chart-too-narrow")).not.toBeInTheDocument()
  })

  it("MT-14 AC4: tooltip item order matches creator click order on hover", async () => {
    const fetchComparisonData = vi.fn(() =>
      Promise.resolve<ComparisonDataResponse>({
        creators: [
          { status: "ok", creatorId: "creator-a", points: [{ label: "Mon", value: 10 }] },
          { status: "ok", creatorId: "creator-b", points: [{ label: "Mon", value: 20 }] },
        ],
      }),
    )
    const { container } = render(
      <ComparisonChart creators={[CREATOR_A, CREATOR_B]} comparisonItemId="revenue" availableComparisonItems={AVAILABLE_ITEMS} width={400} height={200} fetchComparisonData={fetchComparisonData} />,
    )
    await waitFor(() => expect(screen.getByTestId("comparison-chart")).toBeInTheDocument())

    const surface = container.querySelector(".recharts-surface") as SVGSVGElement
    // jsdom never computes real layout; recharts maps mouse position off the
    // surface's own bounding rect, so this fixed rect is what a real browser
    // would return for a 400x200 chart -- not a value chosen to force a
    // particular result.
    surface.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200, toJSON: () => ({}) }) as DOMRect
    fireEvent.mouseOver(surface, { clientX: 200, clientY: 100 })
    fireEvent.mouseMove(surface, { clientX: 200, clientY: 100 })

    await waitFor(() => expect(document.querySelector(".recharts-tooltip-item-list")).not.toBeNull())
    const tooltipNames = document.querySelectorAll(".recharts-tooltip-item-name")
    expect(Array.from(tooltipNames).map((el) => el.textContent)).toEqual(["Creator A", "Creator B"])
  })

  it("GAP-9: tooltip and legend follow creator order even when it is not alphabetical (Recharts sorts tooltip items by name by default)", async () => {
    const zed = { channelId: "creator-zed", channelName: "Zed" }
    const amy = { channelId: "creator-amy", channelName: "Amy" }
    const mia = { channelId: "creator-mia", channelName: "Mia" }
    const fetchComparisonData = vi.fn(() =>
      Promise.resolve<ComparisonDataResponse>({
        creators: [
          { status: "ok", creatorId: "creator-zed", points: [{ label: "Mon", value: 30 }] },
          { status: "ok", creatorId: "creator-amy", points: [{ label: "Mon", value: 10 }] },
          { status: "ok", creatorId: "creator-mia", points: [{ label: "Mon", value: 20 }] },
        ],
      }),
    )
    const { container } = render(
      <ComparisonChart creators={[zed, amy, mia]} comparisonItemId="revenue" availableComparisonItems={AVAILABLE_ITEMS} width={400} height={200} fetchComparisonData={fetchComparisonData} />,
    )
    await waitFor(() => expect(screen.getByTestId("comparison-chart")).toBeInTheDocument())

    const surface = container.querySelector(".recharts-surface") as SVGSVGElement
    surface.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200, toJSON: () => ({}) }) as DOMRect
    fireEvent.mouseOver(surface, { clientX: 200, clientY: 100 })
    fireEvent.mouseMove(surface, { clientX: 200, clientY: 100 })

    await waitFor(() => expect(document.querySelector(".recharts-tooltip-item-list")).not.toBeNull())
    expect(Array.from(document.querySelectorAll(".recharts-tooltip-item-name")).map((el) => el.textContent)).toEqual(["Zed", "Amy", "Mia"])
    expect(Array.from(document.querySelectorAll(".recharts-legend-item-text")).map((el) => el.textContent)).toEqual(["Zed", "Amy", "Mia"])
    expect(Array.from(document.querySelectorAll(".recharts-line")).length).toBe(3)
  })

  it("MT-14 AC6: a partial-error result identifies the failed creator without dropping the other creators' series", async () => {
    const fetchComparisonData = vi.fn(() =>
      Promise.resolve<ComparisonDataResponse>({
        creators: [
          { status: "ok", creatorId: "creator-a", points: [{ label: "Mon", value: 10 }] },
          { status: "error", creatorId: "creator-b" },
        ],
      }),
    )
    render(<ComparisonChart creators={[CREATOR_A, CREATOR_B]} comparisonItemId="revenue" availableComparisonItems={AVAILABLE_ITEMS} width={400} height={200} fetchComparisonData={fetchComparisonData} />)

    await waitFor(() => expect(screen.getByTestId("comparison-chart-issue-creator-b")).toBeInTheDocument())
    expect(screen.getByTestId("comparison-chart-issue-creator-b").getAttribute("data-status")).toBe("error")

    const legendItems = document.querySelectorAll(".recharts-legend-item-text")
    expect(Array.from(legendItems).map((el) => el.textContent)).toEqual(["Creator A"])
    expect(document.querySelectorAll(".recharts-line").length).toBe(1)
  })

  it("MT-14 AC9: an unavailable creator is shown as an actionable, non-color-only status while valid selections remain", async () => {
    const fetchComparisonData = vi.fn(() =>
      Promise.resolve<ComparisonDataResponse>({
        creators: [
          { status: "ok", creatorId: "creator-a", points: [{ label: "Mon", value: 10 }] },
          { status: "unavailable", creatorId: "creator-b" },
        ],
      }),
    )
    render(<ComparisonChart creators={[CREATOR_A, CREATOR_B]} comparisonItemId="revenue" availableComparisonItems={AVAILABLE_ITEMS} width={400} height={200} fetchComparisonData={fetchComparisonData} />)

    await waitFor(() => expect(screen.getByTestId("comparison-chart-issue-creator-b")).toBeInTheDocument())
    const issue = screen.getByTestId("comparison-chart-issue-creator-b")
    expect(issue.getAttribute("data-status")).toBe("unavailable")
    expect(issue.textContent).toContain("Creator B")
    expect(issue.textContent).toContain("No longer available for comparison.")
    // Creator A's series remains untouched by Creator B becoming unavailable.
    expect(document.querySelectorAll(".recharts-legend-item-text")[0].textContent).toBe("Creator A")
  })

  it("MT-14 AC7: a full-error state preserves the widget's creator/item configuration", async () => {
    const fetchComparisonData = vi.fn(() => Promise.reject(new Error("network down")))
    render(<ComparisonChart creators={[CREATOR_A, CREATOR_B]} comparisonItemId="revenue" availableComparisonItems={AVAILABLE_ITEMS} width={400} height={200} fetchComparisonData={fetchComparisonData} />)

    const errorEl = await screen.findByTestId("comparison-chart-error")
    expect(errorEl.textContent).toContain("Couldn't load comparison data.")
    expect(errorEl.textContent).toContain("Creator A, Creator B")
  })

  it("MT-14 AC8: an empty response renders an explicit empty state, not fabricated zero values", async () => {
    const fetchComparisonData = vi.fn(() => Promise.resolve<ComparisonDataResponse>({ creators: [] }))
    render(<ComparisonChart creators={[CREATOR_A, CREATOR_B]} comparisonItemId="revenue" availableComparisonItems={AVAILABLE_ITEMS} width={400} height={200} fetchComparisonData={fetchComparisonData} />)

    await screen.findByTestId("comparison-chart-empty")
    expect(document.querySelectorAll(".recharts-line").length).toBe(0)
  })
})
