import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "../../src/app/styles/index.css"
import "../../src/features/dashboard/styles/dashboard.css"
import { computeWidgetPixelRect, type GridPixelConfig } from "../../src/features/dashboard/editor/utils/dashboardSpacing"
import { renderWidget, type DashboardWidgetData } from "../../src/features/dashboard/editor/utils/widgetRegistry"
import { CanonicalWidgetGrid } from "../../src/features/dashboard/editor/components/DashboardCanonicalEditor"
import { mockVideoStats } from "../../src/features/analytics/data/mockVideoStats"
import { mockDailySeries } from "../../src/features/dashboard/editor/data/mockDailySeries"
import { deriveChannelContribution, deriveKpis } from "../../src/features/analytics/utils/deriveAnalytics"
import { deriveInsights } from "../../src/features/analytics/utils/deriveInsights"
import { MemberThemeProvider } from "../../src/shared/theme/MemberThemeProvider"
import type { WidgetTypeId } from "../../src/features/dashboard/editor/model/widget"
import type { CanonicalLayout } from "../../src/features/dashboard/editor/model/dashboardLayout"

/** GAP-2C browser-verification-only harness. Renders the real production
 * widget components (`renderWidget`, ../../src/lib/widgetRegistry.tsx --
 * the exact function `DashboardGrid.tsx` calls today) inside a box sized by
 * the real production geometry function (`computeWidgetPixelRect`,
 * ../../src/lib/dashboardSpacing.ts) at canonical 0.5X/1X height. No
 * widget/component/CSS is modified -- this only measures fit.
 *
 * `GRID_PIXEL_CONFIG` reproduces `DashboardCanonicalEditor.tsx`'s own
 * (unexported) `DEFAULT_GRID_PIXEL_CONFIG` verbatim. This is not an assumed
 * value: the accompanying Playwright spec independently renders the real
 * `CanonicalWidgetGrid` below (`data-testid="sanity-grid"`) with no
 * `gridPixelConfig` override -- i.e. production's own default -- and
 * measures its actual rendered boxes via `getBoundingClientRect()`,
 * cross-checking that they match what `computeWidgetPixelRect` predicts
 * with these same numbers, before any widget-content measurement is trusted.
 */
const GRID_PIXEL_CONFIG: GridPixelConfig = { columnWidthPx: 320, rowHeightPx: 240 }

const period = "1d" as const
const filteredStats = mockVideoStats
const kpis = deriveKpis(filteredStats)
const contributions = deriveChannelContribution(filteredStats)
const insights = deriveInsights(filteredStats, period)
const byChannel = contributions.slice(0, 8).map((c) => ({ label: c.channelName, value: c.dailyIncrease }))
const byDay = mockDailySeries.map((p) => ({ label: p.date.slice(5), value: p.dailyIncrease }))

const widgetData: DashboardWidgetData = {
  kpis,
  contributions,
  filteredStats,
  insights,
  byDay,
  byChannel,
  period,
  timeZone: "UTC",
}

const WIDGET_TYPES: WidgetTypeId[] = [
  "kpi-summary",
  "growth-bar-chart",
  "contribution-ring",
  "ranking",
  "insights",
  "video-stats-table",
]

function WidgetSizingProbe({ widgetType, heightUnits }: { widgetType: WidgetTypeId; heightUnits: 0.5 | 1 }) {
  const rect = computeWidgetPixelRect({ widgetId: "probe", widgetType, x: 0, y: 0, width: 1, height: heightUnits }, GRID_PIXEL_CONFIG)
  return (
    <div
      data-testid={`widget-probe-${widgetType}-${heightUnits}`}
      data-widget-type={widgetType}
      data-height-units={heightUnits}
      // The canonical box itself (CanonicalWidgetBox's own box model:
      // boxSizing: border-box, no overflow rule -- confirmed by grep that no
      // CSS targets canonical-widget-box/grid).
      style={{ position: "relative", width: rect.width, height: rect.height, boxSizing: "border-box", border: "1px dashed #999", marginBottom: 24 }}
    >
      {/* The real production content wrapper (DashboardGrid.tsx's own
       * `<div className="widget-shell"><div className="widget-shell__body">`)
       * -- confirmed via grep that `.widget-shell__body` is `{ height: 100%;
       * overflow: auto }` in dashboard.css. The canonical model has no
       * content wrapper of its own yet (CanonicalWidgetBox renders no chart
       * content at all today); reusing this already-established class here
       * is what "the actual production widget component... inside the
       * actual canonical widget container" means once GAP-2 wires content
       * in, not an invented new wrapper. */}
      <div className="widget-shell" style={{ width: "100%", height: "100%" }}>
        <div data-testid={`widget-content-${widgetType}-${heightUnits}`} className="widget-shell__body">
          {renderWidget(widgetType, widgetData)}
        </div>
      </div>
    </div>
  )
}

// Geometry sanity-check fixture: one 1X widget and two stacked 0.5X widgets,
// rendered through the real production CanonicalWidgetGrid with no
// gridPixelConfig override (i.e. production's own default).
const SANITY_LAYOUT: CanonicalLayout = {
  grid: { columns: 2, rows: 1 },
  widgets: [
    { widgetId: "sanity-1x", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "sanity-05x-a", widgetType: "kpi-summary", x: 1, y: 0, width: 1, height: 0.5 },
    { widgetId: "sanity-05x-b", widgetType: "kpi-summary", x: 1, y: 0.5, width: 1, height: 0.5 },
  ],
}

function App() {
  return (
    <div>
      <div data-testid="sanity-grid" style={{ position: "relative", height: 260 }}>
        <CanonicalWidgetGrid layout={SANITY_LAYOUT} editMode={false} />
      </div>
      {WIDGET_TYPES.map((type) => (
        <div key={type}>
          <WidgetSizingProbe widgetType={type} heightUnits={0.5} />
          <WidgetSizingProbe widgetType={type} heightUnits={1} />
        </div>
      ))}
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MemberThemeProvider>
      <App />
    </MemberThemeProvider>
  </StrictMode>,
)
