import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { MemberThemeProvider } from "../theme/MemberThemeProvider"
import { DashboardPage } from "./DashboardPage"

function renderDashboard() {
  return render(
    <MemberThemeProvider>
      <DashboardPage />
    </MemberThemeProvider>,
  )
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
})
