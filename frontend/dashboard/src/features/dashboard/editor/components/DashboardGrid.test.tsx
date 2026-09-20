import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { DashboardGrid } from "./DashboardGrid"
import { MemberThemeProvider } from "../../../../shared/theme/MemberThemeProvider"
import { projectCanonicalLayoutForGridStack } from "../utils/dashboardGridProjection"
import type { DashboardWidgetData } from "../utils/widgetRegistry"
import type { CanonicalLayout } from "../model/dashboardLayout"

const DATA: DashboardWidgetData = {
  kpis: { totalViews: 0, totalDailyIncrease: 0, averageGrowthPercent: null, topPerformer: null },
  contributions: [],
  filteredStats: [],
  insights: [],
  byDay: [],
  byChannel: [],
  period: "1d",
  timeZone: "UTC",
}

const LAYOUT: CanonicalLayout = {
  grid: { columns: 3, rows: 1 },
  widgets: [
    { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "candidate", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
    { widgetId: "b", widgetType: "growth-bar-chart", x: 2, y: 0, width: 1, height: 1 },
  ],
}

function renderGrid(props: { placeholderWidgetId?: string | null; locked?: boolean }) {
  const projection = projectCanonicalLayoutForGridStack(LAYOUT)
  render(
    <MemberThemeProvider>
    <DashboardGrid
      widgets={projection.widgets}
      columns={projection.columns}
      editable
      data={DATA}
      onCommitGeometry={vi.fn(() => true)}
      onRemoveWidget={vi.fn()}
      validateGesturePreview={vi.fn(() => true)}
      onAnnounce={vi.fn()}
      {...props}
    />
    </MemberThemeProvider>,
  )
}

describe("DashboardGrid preview placeholder + lock (GAP-7)", () => {
  it("renders the placeholder candidate as a preview-only shell: no Remove, aria-hidden, not the real chart", async () => {
    renderGrid({ placeholderWidgetId: "candidate" })
    const placeholder = await screen.findByTestId("insertion-placeholder")

    expect(placeholder).toHaveAttribute("aria-hidden", "true")
    expect(placeholder).toHaveTextContent("New Rankings (preview)")
    expect(placeholder.closest("[gs-id]")).toHaveAttribute("gs-id", "candidate")
    expect(screen.queryByRole("button", { name: "Remove Rankings" })).not.toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(2)
  })

  it("locked disables every Remove button and marks the grid static (no drag/resize)", async () => {
    renderGrid({ locked: true })
    await waitFor(() => expect(document.querySelector(".grid-stack")).toHaveClass("grid-stack-static"))

    for (const remove of screen.getAllByRole("button", { name: /^Remove / })) expect(remove).toBeDisabled()
  })

  it("unlocked keeps Remove enabled and the grid interactive", async () => {
    renderGrid({})
    await screen.findAllByRole("button", { name: /^Remove / })

    expect(document.querySelector(".grid-stack")).not.toHaveClass("grid-stack-static")
    for (const remove of screen.getAllByRole("button", { name: /^Remove / })) expect(remove).toBeEnabled()
  })
})
