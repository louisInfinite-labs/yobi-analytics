import { StrictMode } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemberThemeProvider } from "../theme/MemberThemeProvider"
import { DashboardPage } from "./DashboardPage"
import * as dashboardChartCatalogSource from "../lib/dashboardChartCatalogSource"

afterEach(() => {
  vi.restoreAllMocks()
})

/** Render DashboardPage wrapped in the theme provider it requires. */
function renderDashboard() {
  return render(
    <MemberThemeProvider>
      <DashboardPage />
    </MemberThemeProvider>,
  )
}

async function renderAndSettle() {
  renderDashboard()
  await waitFor(() => expect(screen.getByText("Daily Gain")).toBeInTheDocument(), { timeout: 2000 })
  await waitFor(() => expect(screen.getByTestId("chart-catalog-status")).toHaveTextContent("success"))
}

describe("DashboardPage", () => {
  it("shows a loading state first, then the KPI section once mock data resolves", async () => {
    renderDashboard()
    expect(screen.getByRole("status", { name: /loading dashboard data/i })).toBeInTheDocument()

    await waitFor(() => expect(screen.getByText("Daily Gain")).toBeInTheDocument(), { timeout: 2000 })
    expect(screen.getAllByText("Total Views").length).toBeGreaterThan(0)
    expect(screen.getByText("Video Statistics")).toBeInTheDocument()
  })

  it("shows the empty state when a filter combination matches no videos", async () => {
    const user = userEvent.setup()
    renderDashboard()
    await waitFor(() => expect(screen.getByText("Daily Gain")).toBeInTheDocument())

    await user.click(screen.getByRole("button", { name: "VSPO" }))
    await user.click(screen.getByRole("button", { name: "3D Live" }))

    expect(await screen.findByText("No videos match the current filters.")).toBeInTheDocument()
  })

  it("reserves the Holodex attribution footer slot ahead of Phase 9", () => {
    renderDashboard()
    expect(screen.getByTestId("holodex-attribution-slot")).toBeInTheDocument()
  })
})

describe("DashboardPage — GAP-1A chart catalog lifecycle wiring", () => {
  it("AC1/AC2: mounting the page makes exactly one catalog fetch", async () => {
    const spy = vi.spyOn(dashboardChartCatalogSource, "fetchMockChartCatalog")
    await renderAndSettle()

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("AC3/AC4/AC5: repeating Edit -> Cancel -> Edit five times keeps the total fetch count at one", async () => {
    const spy = vi.spyOn(dashboardChartCatalogSource, "fetchMockChartCatalog")
    const user = userEvent.setup()
    await renderAndSettle()
    expect(spy).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 5; i++) {
      await user.click(screen.getByRole("button", { name: "Edit Layout" }))
      await user.click(screen.getByRole("button", { name: "Cancel" }))
    }

    expect(spy).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("chart-catalog-status")).toHaveTextContent("success")
  })

  it("AC6: React Strict Mode's mount replay does not increase the fetch count above one", async () => {
    const spy = vi.spyOn(dashboardChartCatalogSource, "fetchMockChartCatalog")
    render(
      <StrictMode>
        <MemberThemeProvider>
          <DashboardPage />
        </MemberThemeProvider>
      </StrictMode>,
    )
    await waitFor(() => expect(screen.getByText("Daily Gain")).toBeInTheDocument(), { timeout: 2000 })
    await waitFor(() => expect(screen.getByTestId("chart-catalog-status")).toHaveTextContent("success"))

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("AC7: a catalog fetch failure does not delete or mutate the existing saved widget/layout state", async () => {
    vi.spyOn(dashboardChartCatalogSource, "fetchMockChartCatalog").mockRejectedValueOnce(new Error("catalog unavailable"))
    renderDashboard()
    await waitFor(() => expect(screen.getByText("Daily Gain")).toBeInTheDocument(), { timeout: 2000 })
    await waitFor(() => expect(screen.getByTestId("chart-catalog-status")).toHaveTextContent("error"))

    // The existing (legacy) saved layout/widgets are still rendered, untouched by the catalog error.
    expect(screen.getByText("Video Statistics")).toBeInTheDocument()
    expect(screen.getAllByText("Total Views").length).toBeGreaterThan(0)
  })

  it("AC2/AC3: view mode and edit mode render the same cached catalog status without an additional fetch", async () => {
    const spy = vi.spyOn(dashboardChartCatalogSource, "fetchMockChartCatalog")
    const user = userEvent.setup()
    await renderAndSettle()

    const viewModeStatus = screen.getByTestId("chart-catalog-status").textContent
    await user.click(screen.getByRole("button", { name: "Edit Layout" }))

    expect(screen.getByTestId("chart-catalog-status")).toHaveTextContent(viewModeStatus!)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
