import { StrictMode, useEffect, useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import "../../src/index.css"
import "../../src/styles/dashboard.css"
import { useDashboardEditor } from "../../src/hooks/useDashboardEditor"
import { DashboardGrid } from "../../src/components/DashboardGrid"
import { updateWidgetGeometry } from "../../src/lib/dashboardWidgetActions"
import { projectCanonicalLayoutForGridStack } from "../../src/lib/dashboardGridProjection"
import { MemberThemeProvider } from "../../src/theme/MemberThemeProvider"
import type { CanonicalLayout } from "../../src/types/dashboardLayout"
import type { DashboardWidgetData } from "../../src/lib/widgetRegistry"

/** GAP-4C browser-verification-only mount point (same convention as
 * mount.tsx/mount-widget-sizing.tsx): not part of App.tsx's own routing,
 * reached only via this dedicated Vite multi-entry HTML page
 * (gap4c-grid-harness.html). Exercises the real, production
 * DashboardGrid.tsx (real GridStack, real dragstop/resizestop wiring, real
 * GAP-4A adapter) and the real useDashboardEditor/projectCanonicalLayoutForGridStack
 * pair DashboardPage.tsx now uses -- only the surrounding page chrome
 * (header/filters/data fetching) is left out, since none of that is owned
 * by or relevant to GAP-4C's pointer-wiring acceptance criteria. */

const FIXTURES: Record<string, CanonicalLayout> = {
  // Column 2 is spare capacity: a valid target for moving "a" into.
  "spare-capacity": {
    grid: { columns: 3, rows: 1 },
    widgets: [
      { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
      { widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
    ],
  },
  // "a" has no neighbor at all, so it can grow rightward without colliding
  // -- unlike "spare-capacity", where "b" sits immediately to "a"'s right
  // and any width growth for "a" would legitimately collide with it.
  "resize-spare-capacity": {
    grid: { columns: 3, rows: 1 },
    widgets: [{ widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 }],
  },
  // growth-bar-chart's GAP-2E allowedHeights is [1] only: resizing it down
  // to 0.5X is a real canonical rejection GridStack itself has no knowledge
  // of (its own resize handle otherwise permits the smaller size).
  "capability-reject": {
    grid: { columns: 2, rows: 1 },
    widgets: [
      { widgetId: "chart", widgetType: "growth-bar-chart", x: 0, y: 0, width: 1, height: 1 },
      { widgetId: "other", widgetType: "kpi-summary", x: 1, y: 0, width: 1, height: 1 },
    ],
  },
  // Fully packed 2-column row, no spare capacity: dragging "a" onto "b"'s
  // cell forces GridStack's own float:true collision resolution
  // (gridstack-engine.js's _fixCollisions, confirmed by inspection to push
  // the collided node down even under float:true) to visually displace "b"
  // as a side effect, without the user ever manipulating "b" directly.
  "collision-neighbor-push": {
    grid: { columns: 2, rows: 1 },
    widgets: [
      { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
      { widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
    ],
  },
  // Dragging "top" away leaves "bottom" as a lone 0.5X widget: an
  // INCOMPLETE_COLUMN rejection GridStack's own drag physics never prevent
  // (it has no concept of a stacked-pair invariant at all).
  "incomplete-column-reject": {
    grid: { columns: 3, rows: 1 },
    widgets: [
      { widgetId: "top", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 0.5 },
      { widgetId: "bottom", widgetType: "kpi-summary", x: 0, y: 0.5, width: 1, height: 0.5 },
      { widgetId: "filler", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
    ],
  },
}

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

function fixtureFromQuery(): CanonicalLayout {
  const key = new URLSearchParams(window.location.search).get("fixture")
  return (key && FIXTURES[key]) || FIXTURES["spare-capacity"]
}

function Harness() {
  const [initialLayout] = useState(fixtureFromQuery)
  const { layout, draftLayout, editMode, enterEditMode, cancel, updateDraftWidget, removeDraftWidget } = useDashboardEditor(initialLayout)
  // GAP-6B: kept realistic (same primitive DashboardPage.tsx itself uses)
  // rather than a stub, so this harness stays a faithful proxy for the real
  // production wiring it exists to exercise.
  const [announcement, setAnnouncement] = useState("")

  // This harness only exercises pointer-gesture wiring, which requires
  // `editable`/non-static GridStack -- entering edit mode once on mount
  // stands in for a real user clicking "Edit Layout".
  useEffect(() => {
    enterEditMode()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const displayed = editMode ? draftLayout : layout
  const projection = useMemo(() => projectCanonicalLayoutForGridStack(displayed), [displayed])

  return (
    <div>
      {/* Test-observable Cancel trigger -- GAP-4C Correction Pass AC15: this
       * harness otherwise has no toolbar (it exists only to drive
       * DashboardGrid's pointer wiring), so a minimal button is the smallest
       * way to reach useDashboardEditor's real `cancel()` from a real
       * browser gesture instead of only a jsdom hook-level call. */}
      <button type="button" data-testid="harness-cancel" onClick={cancel}>
        Cancel
      </button>
      <DashboardGrid
        widgets={projection.widgets}
        columns={projection.columns}
        editable={editMode}
        data={DATA}
        onCommitGeometry={(widgetId, patch) => updateDraftWidget(widgetId, patch)}
        onRemoveWidget={removeDraftWidget}
        validateGesturePreview={(widgetId, patch) => updateWidgetGeometry(draftLayout, widgetId, patch).committed}
        onAnnounce={setAnnouncement}
      />
      <span data-testid="harness-announcement">{announcement}</span>
      {/* Test-observable canonical state -- the same "expose state as a
       * data-testid span" convention DashboardPage.tsx already uses for
       * chart-catalog-status. */}
      <pre data-testid="canonical-json" style={{ position: "fixed", bottom: 0, left: 0, fontSize: 10, maxWidth: "100vw", overflow: "auto" }}>
        {JSON.stringify(displayed)}
      </pre>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MemberThemeProvider>
      <Harness />
    </MemberThemeProvider>
  </StrictMode>,
)
