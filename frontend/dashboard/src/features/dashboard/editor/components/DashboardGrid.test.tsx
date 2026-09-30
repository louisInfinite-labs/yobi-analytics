import { render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { DashboardGrid } from "./DashboardGrid"
import { MemberThemeProvider } from "../../../../shared/theme/MemberThemeProvider"
import { projectCanonicalLayoutForGridStack } from "../utils/dashboardGridProjection"
import type { DashboardWidgetData } from "../utils/widgetRegistry"
import type { CanonicalLayout } from "../model/dashboardLayout"

const DATA: DashboardWidgetData = { creatorId: null }

const LAYOUT: CanonicalLayout = {
  grid: { columns: 3, rows: 1 },
  widgets: [
    { widgetId: "a", widgetType: "subscriber-leaderboard", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "candidate", widgetType: "creator-video-ranking", x: 1, y: 0, width: 1, height: 1 },
    { widgetId: "b", widgetType: "subscriber-leaderboard", x: 2, y: 0, width: 1, height: 1 },
  ],
}

function renderGrid(props: { placeholderWidgetId?: string | null; locked?: boolean; editable?: boolean }) {
  const projection = projectCanonicalLayoutForGridStack(LAYOUT)
  return render(
    <MemberThemeProvider>
    <DashboardGrid
      widgets={projection.widgets}
      columns={projection.columns}
      rows={LAYOUT.grid.rows}
      editable={props.editable ?? true}
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

/** Same shared fixture data/handlers as `renderGrid`, but exposes `rerender`
 * so a test can drive `syncGridToCurrentWidgets` more than once against the
 * SAME mounted tree (`render(...).rerender(...)` re-renders the existing
 * root; a second `render()` call would mount an unrelated second tree). */
function renderGridWithLayout(layout: CanonicalLayout) {
  const projection = projectCanonicalLayoutForGridStack(layout)
  const utils = render(
    <MemberThemeProvider>
      <DashboardGrid
        widgets={projection.widgets}
        columns={projection.columns}
        rows={layout.grid.rows}
        editable
        data={DATA}
        onCommitGeometry={vi.fn(() => true)}
        onRemoveWidget={vi.fn()}
        validateGesturePreview={vi.fn(() => true)}
        onAnnounce={vi.fn()}
      />
    </MemberThemeProvider>,
  )
  function rerenderWithLayout(nextLayout: CanonicalLayout) {
    const nextProjection = projectCanonicalLayoutForGridStack(nextLayout)
    utils.rerender(
      <MemberThemeProvider>
        <DashboardGrid
          widgets={nextProjection.widgets}
          columns={nextProjection.columns}
          rows={nextLayout.grid.rows}
          editable
          data={DATA}
          onCommitGeometry={vi.fn(() => true)}
          onRemoveWidget={vi.fn()}
          validateGesturePreview={vi.fn(() => true)}
          onAnnounce={vi.fn()}
        />
      </MemberThemeProvider>,
    )
  }
  return { ...utils, rerenderWithLayout }
}

describe("DashboardGrid preview placeholder + lock (GAP-7)", () => {
  it("shows one placement guide per canonical cell only while editing", () => {
    const { unmount } = renderGrid({})
    expect(screen.getByTestId("grid-slot-guides").children).toHaveLength(3)

    unmount()
    renderGrid({ editable: false })
    expect(screen.queryByTestId("grid-slot-guides")).not.toBeInTheDocument()
  })

  it("renders the placeholder candidate as a preview-only shell: no Remove, aria-hidden, not the real chart", async () => {
    renderGrid({ placeholderWidgetId: "candidate" })
    const placeholder = await screen.findByTestId("insertion-placeholder")

    expect(placeholder).toHaveAttribute("aria-hidden", "true")
    expect(placeholder).toHaveTextContent("New Creator Video Ranking (preview)")
    expect(placeholder.closest("[gs-id]")).toHaveAttribute("gs-id", "candidate")
    expect(screen.queryByRole("button", { name: "Remove Creator Video Ranking" })).not.toBeInTheDocument()
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

/** The exact portal target `syncGridToCurrentWidgets` itself queries for
 * (see DashboardGrid.tsx) -- reference-equality on this element across a
 * resync is the concrete, observable proxy for "this widget's React subtree
 * was reused, not remounted" (a remount would query a freshly-created
 * element GridStack's own `addWidget()` made instead). */
function portalTarget(instanceId: string): Element | null {
  return document.querySelector(`[gs-id="${instanceId}"] .grid-stack-item-content`)
}

/** Scopes a Remove-button lookup to one widget's own portal target, since
 * `LAYOUT` (and several rerenders below) hold more than one widget of the
 * same `widgetType` -- only "subscriber-leaderboard" and
 * "creator-video-ranking" exist post-R9, so a plain title-text query can
 * match more than one widget and isn't a reliable way to address a specific
 * instance. */
function removeButtonFor(instanceId: string): HTMLElement | null {
  const container = portalTarget(instanceId)
  return container ? within(container as HTMLElement).queryByRole("button", { name: /^Remove /i }) : null
}

describe("DashboardGrid synchronization / portal target preservation (CodeRabbit PR #61)", () => {
  it("keeps an unaffected widget's own DOM/portal target across an ordinary (same-column) sync", async () => {
    const { rerenderWithLayout } = renderGridWithLayout(LAYOUT)
    await screen.findAllByRole("button", { name: /^Remove / })
    const before = portalTarget("a")
    expect(before).not.toBeNull()

    // Same 3 columns; only "b" changes (removed) and a new widget ("c")
    // takes its slot -- "a" and "candidate" are untouched.
    rerenderWithLayout({
      grid: { columns: 3, rows: 1 },
      widgets: [
        { widgetId: "a", widgetType: "subscriber-leaderboard", x: 0, y: 0, width: 1, height: 1 },
        { widgetId: "candidate", widgetType: "creator-video-ranking", x: 1, y: 0, width: 1, height: 1 },
        { widgetId: "c", widgetType: "creator-video-ranking", x: 2, y: 0, width: 1, height: 1 },
      ],
    })
    await waitFor(() => expect(portalTarget("c")).not.toBeNull())

    expect(portalTarget("a")).toBe(before)
  })

  it("survives widget-local state across the same ordinary sync (proxy: the mounted DOM node, not just its text, is identical)", async () => {
    const { rerenderWithLayout } = renderGridWithLayout(LAYOUT)
    await screen.findAllByRole("button", { name: /^Remove / })
    const before = portalTarget("candidate")

    rerenderWithLayout({
      grid: { columns: 3, rows: 1 },
      widgets: [
        { widgetId: "a", widgetType: "subscriber-leaderboard", x: 0, y: 0, width: 1, height: 1 },
        { widgetId: "candidate", widgetType: "creator-video-ranking", x: 1, y: 0, width: 1, height: 1 },
        { widgetId: "b", widgetType: "subscriber-leaderboard", x: 2, y: 1, width: 1, height: 1 },
      ],
    })
    await screen.findAllByRole("button", { name: /^Remove / })

    // Same node -> React's reconciliation for this portal's children never
    // unmounted, so any local state (e.g. an open menu, an uncommitted
    // input) inside "candidate" would have survived too.
    expect(portalTarget("candidate")).toBe(before)
  })

  it("keeps a focused widget control focused across an ordinary sync", async () => {
    const { rerenderWithLayout } = renderGridWithLayout(LAYOUT)
    await screen.findAllByRole("button", { name: /^Remove / })
    const removeA = removeButtonFor("a")!
    removeA.focus()
    expect(removeA).toHaveFocus()

    rerenderWithLayout({
      grid: { columns: 3, rows: 1 },
      widgets: [
        { widgetId: "a", widgetType: "subscriber-leaderboard", x: 0, y: 0, width: 1, height: 1 },
        { widgetId: "candidate", widgetType: "creator-video-ranking", x: 1, y: 0, width: 1, height: 1 },
        { widgetId: "b", widgetType: "subscriber-leaderboard", x: 2, y: 0, width: 2, height: 1 },
      ],
    })
    await screen.findAllByRole("button", { name: /^Remove / })

    expect(removeA).toHaveFocus()
  })

  it("still removes a widget that is genuinely no longer in the layout", async () => {
    const { rerenderWithLayout } = renderGridWithLayout(LAYOUT)
    await waitFor(() => expect(portalTarget("b")).not.toBeNull())

    rerenderWithLayout({
      grid: { columns: 3, rows: 1 },
      widgets: [
        { widgetId: "a", widgetType: "subscriber-leaderboard", x: 0, y: 0, width: 1, height: 1 },
        { widgetId: "candidate", widgetType: "creator-video-ranking", x: 1, y: 0, width: 1, height: 1 },
      ],
    })

    await waitFor(() => expect(portalTarget("b")).toBeNull())
  })

  it("still mounts a genuinely new widget added to the layout", async () => {
    const { rerenderWithLayout } = renderGridWithLayout(LAYOUT)
    const initialButtons = await screen.findAllByRole("button", { name: /^Remove / })
    expect(initialButtons).toHaveLength(LAYOUT.widgets.length)

    rerenderWithLayout({
      grid: { columns: 3, rows: 2 },
      widgets: [
        ...LAYOUT.widgets,
        { widgetId: "d", widgetType: "subscriber-leaderboard", x: 0, y: 1, width: 1, height: 1 },
      ],
    })

    await waitFor(() => expect(portalTarget("d")).not.toBeNull())
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(LAYOUT.widgets.length + 1)
  })

  it("still recreates widget DOM when the column count actually changes, without throwing (the recursion-prevention path stays scoped, not disabled)", async () => {
    const { rerenderWithLayout } = renderGridWithLayout(LAYOUT)
    await screen.findAllByRole("button", { name: /^Remove / })
    const before = portalTarget("a")

    // 3 -> 1 columns: the exact reflow-to-fewer-columns shape the
    // removeAll(true) path exists to protect against (see DashboardGrid.tsx).
    // Must not throw, and -- since the engine IS reset for this case -- "a"
    // gets a fresh DOM/portal target rather than reusing the stale one.
    expect(() =>
      rerenderWithLayout({
        grid: { columns: 1, rows: 3 },
        widgets: [
          { widgetId: "a", widgetType: "subscriber-leaderboard", x: 0, y: 0, width: 1, height: 1 },
          { widgetId: "candidate", widgetType: "creator-video-ranking", x: 0, y: 1, width: 1, height: 1 },
          { widgetId: "b", widgetType: "subscriber-leaderboard", x: 0, y: 2, width: 1, height: 1 },
        ],
      }),
    ).not.toThrow()
    await screen.findAllByRole("button", { name: /^Remove / })

    expect(portalTarget("a")).not.toBe(before)
    expect(portalTarget("a")).not.toBeNull()
  })
})
