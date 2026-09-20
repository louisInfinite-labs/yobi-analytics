import { StrictMode } from "react"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemberThemeProvider } from "../../shared/theme/MemberThemeProvider"
import { DashboardPage } from "./DashboardPage"
import type { ComparisonSource } from "../../features/dashboard/comparison/data/dashboardComparisonSource"
import { fakeComparisonSource } from "../../features/dashboard/editor/test/fakeComparisonSource"
import type { ChartCatalogItem } from "../../features/dashboard/catalog/model/dashboardChartCatalog"
import type { ComparisonDataRequest } from "../../features/dashboard/comparison/model/dashboardComparisonData"

/** What the backend's `GET /dashboard/chart-catalog` returns today. Injected
 * (dependency injection): the page is never coupled to a network. */
const BACKEND_CATALOG: ChartCatalogItem[] = [
  { chartDefinitionId: "kpi-summary", title: "KPI Summary" },
  { chartDefinitionId: "growth-bar-chart", title: "Growth Bar Chart" },
  { chartDefinitionId: "contribution-ring", title: "Channel Contribution" },
  { chartDefinitionId: "ranking", title: "Rankings" },
]

const catalogFetcher = (items: ChartCatalogItem[] = BACKEND_CATALOG) => vi.fn(() => Promise.resolve(items.map((item) => ({ ...item }))))
const failingCatalogFetcher = () => vi.fn(() => Promise.reject<ChartCatalogItem[]>(new Error("catalog unavailable")))

afterEach(() => {
  vi.restoreAllMocks()
})

/** Render DashboardPage wrapped in the theme provider it requires. */
function renderDashboard(comparisonSource: ComparisonSource = fakeComparisonSource, fetchCatalog: () => Promise<ChartCatalogItem[]> = catalogFetcher()) {
  return render(
    <MemberThemeProvider>
      <DashboardPage comparisonSource={comparisonSource} fetchCatalog={fetchCatalog} />
    </MemberThemeProvider>,
  )
}

async function renderAndSettle(comparisonSource?: ComparisonSource, fetchCatalog?: () => Promise<ChartCatalogItem[]>) {
  renderDashboard(comparisonSource, fetchCatalog)
  await waitFor(() => expect(screen.getByText("Daily Gain")).toBeInTheDocument(), { timeout: 2000 })
  await waitFor(() => expect(screen.getByTestId("chart-catalog-status")).toHaveTextContent("success"))
}

describe("DashboardPage", () => {
  it("shows a loading state first, then the KPI section once mock data resolves", async () => {
    renderDashboard()
    expect(screen.getByRole("status", { name: /loading dashboard data/i })).toBeInTheDocument()

    await waitFor(() => expect(screen.getByText("Daily Gain")).toBeInTheDocument(), { timeout: 2000 })
    expect(screen.getAllByText("Total Views").length).toBeGreaterThan(0)
    // GAP-4C: the default layout is now the canonical one (dashboardDefaultLayout.ts:
    // kpi-summary, growth-bar-chart, contribution-ring, ranking), which does not
    // include video-stats-table -- unlike the legacy layoutStore.ts default this
    // page rendered before the cutover. "Ranking" (RankingCard's own heading)
    // proves a distinct, non-KPI canonical-default widget rendered.
    expect(screen.getByText("Ranking")).toBeInTheDocument()
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
    const spy = catalogFetcher()
    await renderAndSettle(undefined, spy)

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("AC3/AC4/AC5: repeating Edit -> Cancel -> Edit five times keeps the total fetch count at one", async () => {
    const spy = catalogFetcher()
    const user = userEvent.setup()
    await renderAndSettle(undefined, spy)
    expect(spy).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 5; i++) {
      await user.click(screen.getByRole("button", { name: "Edit Layout" }))
      await user.click(screen.getByRole("button", { name: "Cancel" }))
    }

    expect(spy).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("chart-catalog-status")).toHaveTextContent("success")
  })

  it("AC6: React Strict Mode's mount replay does not increase the fetch count above one", async () => {
    const spy = catalogFetcher()
    render(
      <StrictMode>
        <MemberThemeProvider>
          <DashboardPage comparisonSource={fakeComparisonSource} fetchCatalog={spy} />
        </MemberThemeProvider>
      </StrictMode>,
    )
    await waitFor(() => expect(screen.getByText("Daily Gain")).toBeInTheDocument(), { timeout: 2000 })
    await waitFor(() => expect(screen.getByTestId("chart-catalog-status")).toHaveTextContent("success"))

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("AC7: a catalog fetch failure does not delete or mutate the existing saved widget/layout state", async () => {
    renderDashboard(undefined, failingCatalogFetcher())
    await waitFor(() => expect(screen.getByText("Daily Gain")).toBeInTheDocument(), { timeout: 2000 })
    await waitFor(() => expect(screen.getByTestId("chart-catalog-status")).toHaveTextContent("error"))

    // The existing canonical saved/default layout widgets are still rendered, untouched by the catalog error.
    expect(screen.getByText("Ranking")).toBeInTheDocument()
    expect(screen.getAllByText("Total Views").length).toBeGreaterThan(0)
  })

  it("AC2/AC3: view mode and edit mode render the same cached catalog status without an additional fetch", async () => {
    const spy = catalogFetcher()
    const user = userEvent.setup()
    await renderAndSettle(undefined, spy)

    const viewModeStatus = screen.getByTestId("chart-catalog-status").textContent
    await user.click(screen.getByRole("button", { name: "Edit Layout" }))

    expect(screen.getByTestId("chart-catalog-status")).toHaveTextContent(viewModeStatus!)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe("DashboardPage — GAP-2F production catalog-driven canonical Add Widget UI", () => {
  function getWidgetTray() {
    return screen.getByText("Widget Library").closest(".widget-tray") as HTMLElement
  }

  function countRemoveButtons(name: string | RegExp) {
    return screen.queryAllByRole("button", { name }).length
  }

  /** GAP-7: a slot click now only activates the preview; "Insert here" is
   * what commits it. */
  async function insertAtSlot(user: ReturnType<typeof userEvent.setup>, slot: HTMLElement) {
    await user.click(slot)
    await user.click(screen.getByRole("button", { name: "Insert here" }))
  }

  it("AC1/AC3: Edit Layout offers exactly the catalog-returned, frontend-supported charts", async () => {
    const user = userEvent.setup()
    await renderAndSettle()

    await user.click(screen.getByRole("button", { name: "Edit Layout" }))

    const tray = within(getWidgetTray())
    // The injected catalog (the backend's current chart-catalog response)
    // returns exactly these four chartDefinitionIds; WidgetTray must show each one's own
    // registry title (never a catalog-provided title -- see WidgetTray.tsx),
    // and nothing else.
    expect(tray.getByRole("button", { name: /KPI Summary/ })).toBeInTheDocument()
    expect(tray.getByRole("button", { name: /Growth Bar Chart/ })).toBeInTheDocument()
    expect(tray.getByRole("button", { name: /Channel Contribution/ })).toBeInTheDocument()
    expect(tray.getByRole("button", { name: /Rankings/ })).toBeInTheDocument()
    expect(tray.getAllByRole("button")).toHaveLength(4)
  })

  it("AC2/AC4: a catalog item the frontend doesn't support is excluded, without crashing the Dashboard", async () => {
    const fetchCatalog = catalogFetcher([
      { chartDefinitionId: "kpi-summary", title: "KPI Summary" },
      { chartDefinitionId: "future-chart-not-yet-supported", title: "Future Chart" },
    ])
    const user = userEvent.setup()
    await renderAndSettle(undefined, fetchCatalog)

    await user.click(screen.getByRole("button", { name: "Edit Layout" }))

    const tray = within(getWidgetTray())
    expect(tray.getByRole("button", { name: /KPI Summary/ })).toBeInTheDocument()
    expect(tray.queryByText("Future Chart")).not.toBeInTheDocument()
    expect(tray.getAllByRole("button")).toHaveLength(1)
    // The rest of the page rendered normally -- an unrenderable catalog
    // entry never reached getWidgetDefinition/renderWidget.
    expect(screen.getByText("Ranking")).toBeInTheDocument()
  })

  it("AC6/AC7: a catalog error shows a distinguishable Add-UI message and leaves existing widgets untouched", async () => {
    const user = userEvent.setup()
    renderDashboard(undefined, failingCatalogFetcher())
    await waitFor(() => expect(screen.getByText("Daily Gain")).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId("chart-catalog-status")).toHaveTextContent("error"))

    await user.click(screen.getByRole("button", { name: "Edit Layout" }))

    const tray = within(getWidgetTray())
    expect(tray.getByTestId("widget-tray-status")).toHaveTextContent(/couldn't load/i)
    expect(tray.getAllByRole("button").map((button) => button.textContent)).toEqual(["Retry"])
    expect(countRemoveButtons(/Remove Rankings/)).toBe(1)
  })

  it("Retry after a catalog error makes exactly one additional request and then offers the returned charts", async () => {
    const user = userEvent.setup()
    const fetchCatalog = vi
      .fn<() => Promise<ChartCatalogItem[]>>()
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValue(BACKEND_CATALOG.map((item) => ({ ...item })))
    renderDashboard(undefined, fetchCatalog)
    await waitFor(() => expect(screen.getByTestId("chart-catalog-status")).toHaveTextContent("error"))
    expect(fetchCatalog).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole("button", { name: "Edit Layout" }))
    await user.click(within(getWidgetTray()).getByRole("button", { name: "Retry" }))

    await waitFor(() => expect(screen.getByTestId("chart-catalog-status")).toHaveTextContent("success"))
    expect(fetchCatalog).toHaveBeenCalledTimes(2)
    expect(within(getWidgetTray()).getByRole("button", { name: /KPI Summary/ })).toBeInTheDocument()
    expect(within(getWidgetTray()).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument()
  })

  it("AC8/AC9/AC10/AC17: selecting a chart does not place it; an explicit slot commits only the draft, and Cancel restores the exact pre-edit state", async () => {
    const user = userEvent.setup()
    await renderAndSettle()
    await user.click(screen.getByRole("button", { name: "Edit Layout" }))

    expect(countRemoveButtons(/Remove KPI Summary/)).toBe(1)

    // AC8: selecting alone must not place the widget.
    await user.click(within(getWidgetTray()).getByRole("button", { name: /KPI Summary/ }))
    expect(countRemoveButtons(/Remove KPI Summary/)).toBe(1)
    expect(screen.getByTestId("widget-insertion-slots")).toBeInTheDocument()

    // AC9/AC10: only an explicit slot + "Insert here" commits, and only to
    // the draft. GAP-7: the slot click alone previews (no draft change).
    const row0 = screen.getByTestId("widget-insertion-row-0")
    await user.click(within(row0).getAllByRole("button")[0])
    expect(countRemoveButtons(/Remove KPI Summary/)).toBe(1)
    await user.click(screen.getByRole("button", { name: "Insert here" }))

    expect(countRemoveButtons(/Remove KPI Summary/)).toBe(2)
    // Picking a slot closes the picker (the pending selection is consumed).
    expect(screen.queryByTestId("widget-insertion-slots")).not.toBeInTheDocument()

    // AC17: Cancel restores canonical state exactly -- the inserted widget
    // disappears, proving the insertion never touched anything but the draft.
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(countRemoveButtons(/Remove KPI Summary/)).toBe(0) // view mode renders no Remove buttons at all
    await user.click(screen.getByRole("button", { name: "Edit Layout" }))
    expect(countRemoveButtons(/Remove KPI Summary/)).toBe(1)
  })

  it("AC11: an insertion slot that would exceed the supported grid range is rejected, changing no state", async () => {
    const user = userEvent.setup()
    await renderAndSettle()
    await user.click(screen.getByRole("button", { name: "Edit Layout" }))

    const tray = within(getWidgetTray())
    const row0 = () => screen.getByTestId("widget-insertion-row-0")

    // The default layout's row 0 starts with 2 widgets (kpi-summary,
    // growth-bar-chart). Grow it to the supported 3-column maximum.
    await user.click(tray.getByRole("button", { name: /KPI Summary/ }))
    await insertAtSlot(user, within(row0()).getAllByRole("button")[0])
    expect(countRemoveButtons(/Remove KPI Summary/)).toBe(2) // 1 original + 1 inserted
    const draftWidgetCountBeforeRejection = screen.getAllByRole("button", { name: /^Remove /i }).length

    // A 4th widget in the same row would need a 4th column -- outside the
    // canonical 1x1-3x3 range -- so `addWidgetAtSlot` must reject it.
    await user.click(tray.getByRole("button", { name: /KPI Summary/ }))
    await user.click(within(row0()).getAllByRole("button")[0])

    expect(screen.getByTestId("widget-insertion-rejected")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: /^Remove /i })).toHaveLength(draftWidgetCountBeforeRejection)
    // Rejection keeps the picker open (only a successful slot closes it) so
    // the user can pick a different target instead of losing their selection.
    expect(screen.getByTestId("widget-insertion-slots")).toBeInTheDocument()
  })

  it("AC15: two rapid clicks on the same slot button insert at most one widget", async () => {
    await renderAndSettle()
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Edit Layout" }))
    await user.click(within(getWidgetTray()).getByRole("button", { name: /KPI Summary/ }))

    fireEvent.click(within(screen.getByTestId("widget-insertion-row-0")).getAllByRole("button")[0])
    const insertButton = screen.getByRole("button", { name: "Insert here" })
    // A successful commit synchronously clears the pending selection and
    // unmounts this picker (see the AC8/AC9/AC10 test above) -- firing a
    // second raw click at the same, now-detached node proves a double-fire
    // can insert at most once, without relying on a debounce/lock.
    fireEvent.click(insertButton)
    fireEvent.click(insertButton)

    expect(countRemoveButtons(/Remove KPI Summary/)).toBe(2) // 1 original + exactly 1 inserted
  })

  describe("GAP-7 preview phase", () => {
    async function startPreview(user: ReturnType<typeof userEvent.setup>, slotIndex: number) {
      await user.click(screen.getByRole("button", { name: "Edit Layout" }))
      await user.click(within(getWidgetTray()).getByRole("button", { name: /KPI Summary/ }))
      const slots = within(screen.getByTestId("widget-insertion-row-0")).getAllByRole("button")
      await user.click(slots[slotIndex])
    }

    it("AC1/AC2/AC26/AC27: selecting a type changes nothing; a slot click shows a placeholder, marks the slot, and states the pending change", async () => {
      const user = userEvent.setup()
      await renderAndSettle()
      await user.click(screen.getByRole("button", { name: "Edit Layout" }))
      await user.click(within(getWidgetTray()).getByRole("button", { name: /KPI Summary/ }))
      expect(screen.queryByTestId("insertion-placeholder")).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Insert here" })).toBeDisabled()

      const slots = within(screen.getByTestId("widget-insertion-row-0")).getAllByRole("button")
      await user.click(slots[1])

      expect(screen.getByTestId("insertion-placeholder")).toHaveAttribute("aria-hidden", "true")
      expect(slots[1]).toHaveAttribute("aria-pressed", "true")
      expect(slots[1]).toHaveTextContent("✓")
      expect(slots[0]).toHaveAttribute("aria-pressed", "false")
      expect(screen.getByTestId("widget-insertion-preview-status")).toHaveTextContent(
        "Previewing KPI Summary at position 2 in row 1; grid becomes 3 columns.",
      )
      expect(countRemoveButtons(/^Remove /)).toBe(4) // the placeholder has no Remove
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
      // No success announcement yet.
      expect(screen.getByTestId("dashboard-editor-announcer")).toBeEmptyDOMElement()
    })

    it("AC7/AC9: another slot replaces the preview; panel Cancel clears it and leaves the draft as it was", async () => {
      const user = userEvent.setup()
      await renderAndSettle()
      await startPreview(user, 1)
      await user.click(within(screen.getByTestId("widget-insertion-row-0")).getAllByRole("button")[2])
      expect(screen.getAllByTestId("insertion-placeholder")).toHaveLength(1)
      expect(screen.getByTestId("widget-insertion-preview-status")).toHaveTextContent("position 3")

      await user.click(within(screen.getByTestId("widget-insertion-slots")).getByRole("button", { name: "Cancel" }))
      expect(screen.queryByTestId("insertion-placeholder")).not.toBeInTheDocument()
      expect(screen.queryByTestId("widget-insertion-slots")).not.toBeInTheDocument()
      expect(countRemoveButtons(/^Remove /)).toBe(4)
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled() // draft still clean
    })

    it("AC22/AC23: Insert here commits once, clears preview + pending, and announces once", async () => {
      const user = userEvent.setup()
      await renderAndSettle()
      await startPreview(user, 1)
      await user.click(screen.getByRole("button", { name: "Insert here" }))

      expect(screen.queryByTestId("insertion-placeholder")).not.toBeInTheDocument()
      expect(screen.queryByTestId("widget-insertion-slots")).not.toBeInTheDocument()
      expect(countRemoveButtons(/Remove KPI Summary/)).toBe(2)
      expect(screen.getByTestId("dashboard-editor-announcer")).toHaveTextContent("KPI Summary added at position 2 in row 1.")
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
    })

    it("AC20: choosing another widget type clears the preview", async () => {
      const user = userEvent.setup()
      await renderAndSettle()
      await startPreview(user, 1)
      await user.click(within(getWidgetTray()).getByRole("button", { name: /Rankings/ }))

      expect(screen.queryByTestId("insertion-placeholder")).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Insert here" })).toBeDisabled()
    })

    it("AC10/AC19: Dashboard Cancel and Restore Default leave no preview behind", async () => {
      const user = userEvent.setup()
      await renderAndSettle()
      await startPreview(user, 1)
      await user.click(screen.getByRole("button", { name: "Restore Default" }))
      expect(screen.queryByTestId("insertion-placeholder")).not.toBeInTheDocument()
      expect(screen.queryByTestId("widget-insertion-slots")).not.toBeInTheDocument()

      await startPreviewAgain(user)
      // The insertion panel has its own Cancel; scope to the toolbar's.
      await user.click(within(screen.getByRole("toolbar")).getByRole("button", { name: "Cancel" }))
      expect(screen.queryByTestId("insertion-placeholder")).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Edit Layout" })).toBeInTheDocument()
    })

    async function startPreviewAgain(user: ReturnType<typeof userEvent.setup>) {
      await user.click(within(getWidgetTray()).getByRole("button", { name: /KPI Summary/ }))
      await user.click(within(screen.getByTestId("widget-insertion-row-0")).getAllByRole("button")[1])
      expect(screen.getByTestId("insertion-placeholder")).toBeInTheDocument()
    }

    it("AC17: Remove is disabled while a preview's geometry is displayed", async () => {
      const user = userEvent.setup()
      await renderAndSettle()
      await startPreview(user, 1)
      for (const remove of screen.getAllByRole("button", { name: /^Remove / })) expect(remove).toBeDisabled()
    })
  })
})

describe("DashboardPage — GAP-8D legacy 4/5-column saved-layout recovery", () => {
  const KEY = "yobi-analytics-canonical-dashboard-layout"
  const BACKUP_KEY = `${KEY}-legacy-backup`
  const unit = (widgetId: string, widgetType: string, x: number, y: number) => ({ widgetId, widgetType, x, y, width: 1, height: 1 })
  const MIGRATABLE_RAW = JSON.stringify({
    grid: { columns: 4, rows: 2 },
    widgets: [unit("a", "kpi-summary", 0, 0), unit("b", "ranking", 1, 0), unit("c", "insights", 2, 0), unit("d", "kpi-summary", 3, 0), unit("e", "ranking", 0, 1)],
  })
  const UNMIGRATABLE_RAW = JSON.stringify({
    grid: { columns: 5, rows: 2 },
    widgets: Array.from({ length: 10 }, (_, i) => unit(`g${i}`, i % 2 ? "growth-bar-chart" : "contribution-ring", i % 5, Math.floor(i / 5))),
  })

  afterEach(() => window.localStorage.clear())

  it("a migratable legacy payload shows the recovery banner and Convert, with Edit unavailable and storage untouched", async () => {
    window.localStorage.setItem(KEY, MIGRATABLE_RAW)
    await renderAndSettle()

    expect(screen.getByTestId("legacy-layout-banner")).toHaveTextContent("older grid size")
    expect(screen.getByTestId("legacy-layout-banner")).toHaveTextContent("preserved")
    expect(screen.getByTestId("legacy-layout-convert-note")).toHaveTextContent(/positions/i)
    expect(screen.getByTestId("legacy-layout-convert-note")).toHaveTextContent(/IDs and settings will be preserved/i)
    expect(screen.getByRole("button", { name: "Convert to 3x3" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Edit Layout" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /reset|start with default/i })).not.toBeInTheDocument()
    expect(window.localStorage.getItem(KEY)).toBe(MIGRATABLE_RAW)
    expect(window.localStorage.getItem(BACKUP_KEY)).toBeNull()
  })

  it("an unmigratable legacy payload shows an explanation, no Convert action, no Edit, and byte-identical storage", async () => {
    window.localStorage.setItem(KEY, UNMIGRATABLE_RAW)
    await renderAndSettle()

    expect(screen.getByTestId("legacy-layout-no-convert")).toHaveTextContent(/cannot be converted/i)
    expect(screen.queryByRole("button", { name: "Convert to 3x3" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Edit Layout" })).not.toBeInTheDocument()
    expect(window.localStorage.getItem(KEY)).toBe(UNMIGRATABLE_RAW)
  })

  it("Convert backs up the exact raw payload, writes a valid <=3x3 primary, and the remounted page is a normal editable Dashboard", async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(KEY, MIGRATABLE_RAW)
    await renderAndSettle()

    await user.click(screen.getByRole("button", { name: "Convert to 3x3" }))

    await waitFor(() => expect(screen.queryByTestId("legacy-layout-banner")).not.toBeInTheDocument())
    expect(window.localStorage.getItem(BACKUP_KEY)).toBe(MIGRATABLE_RAW)
    const saved = JSON.parse(window.localStorage.getItem(KEY)!)
    expect(saved.grid.columns).toBeLessThanOrEqual(3)
    expect(saved.grid.rows).toBeLessThanOrEqual(3)
    expect(saved.widgets.map((w: { widgetId: string }) => w.widgetId)).toEqual(["a", "b", "c", "d", "e"])
    await waitFor(() => expect(screen.getAllByText("Daily Gain").length).toBeGreaterThan(0), { timeout: 2000 })
    expect(await screen.findByRole("button", { name: "Edit Layout" })).toBeInTheDocument()
  })

  it("a backup failure keeps the banner, shows an actionable error, and leaves the primary byte-identical", async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(KEY, MIGRATABLE_RAW)
    await renderAndSettle()
    const realSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === BACKUP_KEY) throw new Error("quota")
      realSetItem.call(this, key, value)
    })

    await user.click(screen.getByRole("button", { name: "Convert to 3x3" }))

    expect(await screen.findByTestId("legacy-layout-convert-error")).toBeInTheDocument()
    expect(screen.getByTestId("legacy-layout-banner")).toBeInTheDocument()
    expect(window.localStorage.getItem(KEY)).toBe(MIGRATABLE_RAW)
  })

  it("a current 3x3 layout shows no recovery banner and keeps Edit available", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ grid: { columns: 3, rows: 1 }, widgets: [unit("a", "kpi-summary", 0, 0), unit("b", "ranking", 1, 0), unit("c", "insights", 2, 0)] }))
    await renderAndSettle()

    expect(screen.queryByTestId("legacy-layout-banner")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Edit Layout" })).toBeInTheDocument()
  })
})

describe("DashboardPage — GAP-9 live comparison integration (MT-10 through MT-14)", () => {
  const LAYOUT_KEY = "yobi-analytics-canonical-dashboard-layout"
  const ACTIVE_CREATOR_KEY = "yobi.home.selectedCreatorId"
  const A = { id: "ch_gawr_gura", name: "Gawr Gura" }
  const B = { id: "ch_iofi", name: "Airani Iofifteen" }
  const C = { id: "ch_kiryu_coco", name: "桐生ココ" }
  const unit = (widgetId: string, widgetType: string, x: number, y: number, extra: object = {}) => ({ widgetId, widgetType, x, y, width: 1, height: 1, ...extra })
  const TWO_WIDGETS_SHUFFLED = { grid: { columns: 2, rows: 2 }, widgets: [unit("w1", "ranking", 1, 0), unit("w0", "kpi-summary", 0, 0)] }
  const COMPARISON_LAYOUT = {
    grid: { columns: 2, rows: 1 },
    widgets: [
      unit("cmp0", "creator-comparison-chart", 0, 0, { comparison: { creatorIds: [A.id], comparisonItemIds: ["daily-view-growth"] } }),
      unit("cmp1", "creator-comparison-chart", 1, 0, { comparison: { creatorIds: [A.id, B.id], comparisonItemIds: ["total-views"] } }),
    ],
  }

  afterEach(() => {
    window.localStorage.clear()
  })

  /** An injected source that records every outgoing request (dependency injection, no globals). */
  function recordingSource(): { source: ComparisonSource; requests: ComparisonDataRequest[] } {
    const requests: ComparisonDataRequest[] = []
    return {
      requests,
      source: {
        ...fakeComparisonSource,
        fetchData: (request) => {
          requests.push({ creatorIds: [...request.creatorIds], comparisonItemIds: [...request.comparisonItemIds] })
          return fakeComparisonSource.fetchData(request)
        },
      },
    }
  }

  function seedLayout(layout: unknown) {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
  }
  const badgeText = (button: HTMLElement) => button.querySelector(".comparison-order-badge")?.getAttribute("aria-label") ?? null
  const storedWidgets = () => JSON.parse(window.localStorage.getItem(LAYOUT_KEY)!).widgets as { widgetId: string; comparison?: { creatorIds: string[]; comparisonItemIds: string[] } }[]
  const listIds = (widgetId: string) =>
    Array.from(
      document.querySelector(`[data-widget-id="${widgetId}"] [data-testid="comparison-widget-creators"]`)!.querySelectorAll("li"),
    ).map((li) => li.getAttribute("data-creator-id"))

  it("Flow 2 is reachable from the live page: ordered selection, visual-order preview, one atomic save, widgets render at once, catalog loaded once, active creator untouched", async () => {
    const catalogSpy = catalogFetcher()
    const user = userEvent.setup()
    seedLayout(TWO_WIDGETS_SHUFFLED)
    const { source, requests } = recordingSource()
    await renderAndSettle(source, catalogSpy)
    const activeBefore = window.localStorage.getItem(ACTIVE_CREATOR_KEY)
    const setItem = vi.spyOn(Storage.prototype, "setItem")

    await user.click(screen.getByRole("button", { name: "Compare Creators" }))
    let dialog = screen.getByRole("dialog", { name: "Add Comparison Charts" })
    for (const creator of [A, B, C]) await user.click(within(dialog).getByRole("button", { name: creator.name }))
    expect([A, B, C].map((c) => badgeText(within(dialog).getByRole("button", { name: c.name })))).toEqual(["Comparison order 1", "Comparison order 2", "Comparison order 3"])

    // Deselect B, then reselect it: A(1), C(2), B(3).
    await user.click(within(dialog).getByRole("button", { name: B.name }))
    expect([A, B, C].map((c) => badgeText(within(dialog).getByRole("button", { name: c.name })))).toEqual(["Comparison order 1", null, "Comparison order 2"])
    await user.click(within(dialog).getByRole("button", { name: B.name }))
    expect([A, B, C].map((c) => badgeText(within(dialog).getByRole("button", { name: c.name })))).toEqual(["Comparison order 1", "Comparison order 3", "Comparison order 2"])
    // Reopen for the mapping below so the selection is exactly A, B, C.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await user.click(screen.getByRole("button", { name: "Compare Creators" }))
    dialog = screen.getByRole("dialog", { name: "Add Comparison Charts" })
    for (const creator of [A, B, C]) await user.click(within(dialog).getByRole("button", { name: creator.name }))
    expect([A, B, C].map((c) => badgeText(within(dialog).getByRole("button", { name: c.name })))).toEqual(["Comparison order 1", "Comparison order 2", "Comparison order 3"])

    // Items are chosen in this order (not the backend's definition order): item order is the caller's.
    for (const item of ["Total views", "Daily view growth"]) await user.click(within(dialog).getByRole("button", { name: item }))
    expect(within(dialog).getAllByTestId("comparison-mapping-row").map((row) => row.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Total views → widget[0]",
      "Daily view growth → widget[1]",
    ])
    expect(setItem.mock.calls.filter(([key]) => key === LAYOUT_KEY)).toHaveLength(0) // the preview writes nothing

    await user.click(within(dialog).getByRole("button", { name: "Save" }))

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add Comparison Charts" })).not.toBeInTheDocument())
    expect(setItem.mock.calls.filter(([key]) => key === LAYOUT_KEY)).toHaveLength(1)
    expect(screen.getAllByTestId("comparison-widget")).toHaveLength(2)
    const widgets = storedWidgets()
    // w0 is the top-left widget (visual order) even though it is stored second.
    expect(widgets.find((x) => x.widgetId === "w0")!.comparison).toEqual({ creatorIds: [A.id, B.id, C.id], comparisonItemIds: ["total-views"] })
    expect(widgets.find((x) => x.widgetId === "w1")!.comparison).toEqual({ creatorIds: [A.id, B.id, C.id], comparisonItemIds: ["daily-view-growth"] })
    expect(widgets).toHaveLength(2)
    expect(new Set(widgets.map((x) => x.widgetId)).size).toBe(2)
    expect(window.localStorage.getItem(ACTIVE_CREATOR_KEY)).toBe(activeBefore)
    expect(catalogSpy).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(2))
    for (const request of requests) expect(request.creatorIds).toEqual([A.id, B.id, C.id])
    expect(screen.getAllByTestId("comparison-widget-sample-data").length).toBe(2) // an injected sample source is labelled as sample data
  })

  it("Flow 2 appends exactly one new widget with a unique id when there are more items than widgets, without moving the existing one", async () => {
    const user = userEvent.setup()
    seedLayout({ grid: { columns: 2, rows: 2 }, widgets: [unit("only", "kpi-summary", 1, 0)] })
    await renderAndSettle()

    await user.click(screen.getByRole("button", { name: "Compare Creators" }))
    const dialog = screen.getByRole("dialog", { name: "Add Comparison Charts" })
    for (const creator of [A, B]) await user.click(within(dialog).getByRole("button", { name: creator.name }))
    for (const item of ["Daily view growth", "Total views"]) await user.click(within(dialog).getByRole("button", { name: item }))
    await user.click(within(dialog).getByRole("button", { name: "Save" }))

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add Comparison Charts" })).not.toBeInTheDocument())
    const widgets = JSON.parse(window.localStorage.getItem(LAYOUT_KEY)!).widgets as { widgetId: string; x: number; y: number; comparison: { comparisonItemIds: string[] } }[]
    expect(widgets).toHaveLength(2)
    expect(widgets[0]).toMatchObject({ widgetId: "only", x: 1, y: 0 })
    expect(widgets[0].comparison.comparisonItemIds).toEqual(["daily-view-growth"])
    expect(widgets[1].widgetId).not.toBe("only")
    expect(widgets[1].comparison.comparisonItemIds).toEqual(["total-views"])
    expect(screen.getAllByTestId("comparison-widget")).toHaveLength(2)
  })

  it("Flow 2 rolls back on a failed save: the dialog stays open with an alert, storage and the page are unchanged", async () => {
    const user = userEvent.setup()
    seedLayout(TWO_WIDGETS_SHUFFLED)
    await renderAndSettle()
    const raw = window.localStorage.getItem(LAYOUT_KEY)

    await user.click(screen.getByRole("button", { name: "Compare Creators" }))
    const dialog = screen.getByRole("dialog", { name: "Add Comparison Charts" })
    for (const creator of [A, B]) await user.click(within(dialog).getByRole("button", { name: creator.name }))
    await user.click(within(dialog).getByRole("button", { name: "Daily view growth" }))
    const realSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === LAYOUT_KEY) throw new Error("quota")
      realSetItem.call(this, key, value)
    })
    await user.click(within(dialog).getByRole("button", { name: "Save" }))

    expect(await within(dialog).findByRole("alert")).toBeInTheDocument()
    expect(screen.getByRole("dialog", { name: "Add Comparison Charts" })).toBeInTheDocument()
    expect(window.localStorage.getItem(LAYOUT_KEY)).toBe(raw)
    expect(screen.queryByTestId("comparison-widget")).not.toBeInTheDocument()
  })

  it("Flow 2 Cancel changes nothing, and the entry point is not offered while editing", async () => {
    const user = userEvent.setup()
    seedLayout(TWO_WIDGETS_SHUFFLED)
    await renderAndSettle()
    const raw = window.localStorage.getItem(LAYOUT_KEY)

    await user.click(screen.getByRole("button", { name: "Compare Creators" }))
    await user.click(within(screen.getByRole("dialog", { name: "Add Comparison Charts" })).getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("dialog", { name: "Add Comparison Charts" })).not.toBeInTheDocument()
    expect(window.localStorage.getItem(LAYOUT_KEY)).toBe(raw)

    await user.click(screen.getByRole("button", { name: "Edit Layout" }))
    expect(screen.queryByRole("button", { name: "Compare Creators" })).not.toBeInTheDocument()
  })

  it("Flow 1 is reachable on a comparison widget in edit mode: Cancel leaves the draft alone, Apply updates only the draft, Save persists through the normal flow", async () => {
    const catalogSpy = catalogFetcher()
    const user = userEvent.setup()
    seedLayout(COMPARISON_LAYOUT)
    renderDashboard(undefined, catalogSpy)
    await waitFor(() => expect(screen.getByTestId("chart-catalog-status")).toHaveTextContent("success"), { timeout: 2000 })
    await waitFor(() => expect(screen.getAllByTestId("comparison-widget")).toHaveLength(2))
    const raw = window.localStorage.getItem(LAYOUT_KEY)
    const activeBefore = window.localStorage.getItem(ACTIVE_CREATOR_KEY)
    expect(screen.queryByRole("button", { name: "Select Creators" })).not.toBeInTheDocument() // view mode

    await user.click(screen.getByRole("button", { name: "Edit Layout" }))
    const selectButtons = screen.getAllByRole("button", { name: "Select Creators" })
    expect(selectButtons).toHaveLength(2)

    await user.click(selectButtons[0])
    let picker = screen.getByRole("dialog", { name: "Select Creators" })
    await user.click(within(picker).getByRole("button", { name: B.name }))
    await user.click(within(picker).getByRole("button", { name: "Cancel" }))
    expect(listIds("cmp0")).toEqual([A.id])
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()

    await user.click(screen.getAllByRole("button", { name: "Select Creators" })[0])
    picker = screen.getByRole("dialog", { name: "Select Creators" })
    expect(badgeText(within(picker).getByRole("button", { name: A.name }))).toBe("Comparison order 1") // existing ids appear selected
    await user.click(within(picker).getByRole("button", { name: B.name }))
    await user.click(within(picker).getByRole("button", { name: C.name }))
    await user.click(within(picker).getByRole("button", { name: "Apply" }))

    expect(listIds("cmp0")).toEqual([A.id, B.id, C.id])
    expect(listIds("cmp1")).toEqual([A.id, B.id]) // only the target widget
    expect(window.localStorage.getItem(LAYOUT_KEY)).toBe(raw) // not saved yet

    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument())
    const saved = storedWidgets()
    expect(saved.find((x) => x.widgetId === "cmp0")!.comparison).toEqual({ creatorIds: [A.id, B.id, C.id], comparisonItemIds: ["daily-view-growth"] })
    expect(saved.map((x) => x.widgetId)).toEqual(["cmp0", "cmp1"])
    expect(window.localStorage.getItem(ACTIVE_CREATOR_KEY)).toBe(activeBefore)
    expect(catalogSpy).toHaveBeenCalledTimes(1)
  })

  it("a legacy 4/5-column payload awaiting conversion offers no comparison entry point", async () => {
    seedLayout({ grid: { columns: 4, rows: 1 }, widgets: [0, 1, 2, 3].map((i) => unit(`w${i}`, "kpi-summary", i, 0)) })
    await renderAndSettle()
    expect(screen.getByTestId("legacy-layout-banner")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Compare Creators" })).not.toBeInTheDocument()
  })
})
