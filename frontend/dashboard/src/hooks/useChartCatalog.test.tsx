import { StrictMode, useState } from "react"
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useChartCatalog } from "./useChartCatalog"
import { useDashboardWidgets } from "./useDashboardWidgets"
import type { ChartCatalogItem } from "../types/dashboardChartCatalog"
import type { CanonicalLayout } from "../types/dashboardLayout"

const FIXTURE_ITEMS: ChartCatalogItem[] = [
  { chartDefinitionId: "revenue-trend", title: "Revenue Trend" },
  { chartDefinitionId: "engagement-funnel", title: "Engagement Funnel" },
]

/** A never-resolving promise, for asserting the pending state without racing a timer. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

/** Renders the catalog plus an Edit/view mode toggle next to it -- the
 * harness the AC2/AC3 assertions drive. The real Dashboard page and its
 * add-widget UI are owned by a later editor-shell microtask; this proves
 * the single-instance hook contract (Section 3.3, rules 3-5) that any such
 * consumer will rely on.
 */
function Harness({ fetchCatalog }: { fetchCatalog: () => Promise<ChartCatalogItem[]> }) {
  const { state, retry } = useChartCatalog(fetchCatalog)
  const [mode, setMode] = useState<"view" | "edit">("view")
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <button onClick={() => setMode((m: "view" | "edit") => (m === "view" ? "edit" : "view"))}>Edit</button>
      <button onClick={retry}>Retry</button>
      <span data-testid="status">{state.status}</span>
      {state.status === "success" && (
        <ul>
          {state.items.map((item) => (
            <li key={item.chartDefinitionId} data-testid="catalog-item">
              {item.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

describe("useChartCatalog", () => {
  it("makes exactly one catalog request on initial render", () => {
    const fetchCatalog = vi.fn(() => pending<ChartCatalogItem[]>())
    renderHook(() => useChartCatalog(fetchCatalog))
    expect(fetchCatalog).toHaveBeenCalledTimes(1)
  })

  it("starts in the loading state before the fetch resolves", () => {
    const fetchCatalog = vi.fn(() => pending<ChartCatalogItem[]>())
    const { result } = renderHook(() => useChartCatalog(fetchCatalog))
    expect(result.current.state).toEqual({ status: "loading" })
  })

  it("resolves to success with exactly the items the fetch returned", async () => {
    const fetchCatalog = vi.fn(() => Promise.resolve(FIXTURE_ITEMS))
    const { result } = renderHook(() => useChartCatalog(fetchCatalog))

    await waitFor(() => expect(result.current.state.status).toBe("success"))
    expect(result.current.state).toEqual({ status: "success", items: FIXTURE_ITEMS })
  })

  it("resolves to a distinguishable empty success state when the backend returns an empty catalog", async () => {
    const fetchCatalog = vi.fn(() => Promise.resolve<ChartCatalogItem[]>([]))
    const { result } = renderHook(() => useChartCatalog(fetchCatalog))

    await waitFor(() => expect(result.current.state.status).toBe("success"))
    expect(result.current.state).toEqual({ status: "success", items: [] })
  })

  it("surfaces a rejected fetch as a distinguishable error state", async () => {
    const fetchCatalog = vi.fn(() => Promise.reject(new Error("catalog unavailable")))
    const { result } = renderHook(() => useChartCatalog(fetchCatalog))

    await waitFor(() => expect(result.current.state.status).toBe("error"))
    expect(result.current.state).toMatchObject({ status: "error", error: expect.any(Error) })
  })

  it("clicking Edit makes zero additional catalog requests", async () => {
    const fetchCatalog = vi.fn(() => Promise.resolve(FIXTURE_ITEMS))
    render(<Harness fetchCatalog={fetchCatalog} />)

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("success"))
    expect(fetchCatalog).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("button", { name: "Edit" }))

    expect(screen.getByTestId("mode").textContent).toBe("edit")
    expect(fetchCatalog).toHaveBeenCalledTimes(1)
  })

  it("toggling view/edit mode five times keeps the total catalog request count at one", async () => {
    const fetchCatalog = vi.fn(() => Promise.resolve(FIXTURE_ITEMS))
    render(<Harness fetchCatalog={fetchCatalog} />)

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("success"))

    const editButton = screen.getByRole("button", { name: "Edit" })
    for (let i = 0; i < 5; i++) fireEvent.click(editButton)

    expect(fetchCatalog).toHaveBeenCalledTimes(1)
  })

  it("does not increase the request count above one under React Strict Mode", async () => {
    const fetchCatalog = vi.fn(() => Promise.resolve(FIXTURE_ITEMS))
    render(
      <StrictMode>
        <Harness fetchCatalog={fetchCatalog} />
      </StrictMode>,
    )

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("success"))
    expect(fetchCatalog).toHaveBeenCalledTimes(1)
    expect(screen.getAllByTestId("catalog-item")).toHaveLength(FIXTURE_ITEMS.length)
  })

  it("an explicit retry after a failed request makes exactly one additional request", async () => {
    const fetchCatalog = vi
      .fn<() => Promise<ChartCatalogItem[]>>()
      .mockRejectedValueOnce(new Error("first attempt failed"))
      .mockResolvedValueOnce(FIXTURE_ITEMS)
    render(<Harness fetchCatalog={fetchCatalog} />)

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("error"))
    expect(fetchCatalog).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    })

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("success"))
    expect(fetchCatalog).toHaveBeenCalledTimes(2)
  })

  it("the add-widget UI contains only chart definitions returned by the fixture response", async () => {
    const fetchCatalog = vi.fn(() => Promise.resolve(FIXTURE_ITEMS))
    render(<Harness fetchCatalog={fetchCatalog} />)

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("success"))

    const rendered = screen.getAllByTestId("catalog-item").map((el) => el.textContent)
    expect(rendered).toEqual(FIXTURE_ITEMS.map((item) => item.title))
  })

  it("a catalog error does not delete existing widgets", async () => {
    const seeded: CanonicalLayout = {
      grid: { columns: 2, rows: 2 },
      widgets: [{ widgetId: "seed-1", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 }],
    }
    const fetchCatalog = vi.fn(() => Promise.reject(new Error("catalog unavailable")))

    function CombinedHarness() {
      const { layout } = useDashboardWidgets(seeded)
      const { state } = useChartCatalog(fetchCatalog)
      return (
        <div>
          <span data-testid="status">{state.status}</span>
          <ul>
            {layout.widgets.map((widget) => (
              <li key={widget.widgetId} data-testid="widget-row" data-widget-id={widget.widgetId} />
            ))}
          </ul>
        </div>
      )
    }

    render(<CombinedHarness />)

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("error"))
    const rows = screen.getAllByTestId("widget-row")
    expect(rows).toHaveLength(1)
    expect(rows[0].dataset.widgetId).toBe("seed-1")
  })
})
