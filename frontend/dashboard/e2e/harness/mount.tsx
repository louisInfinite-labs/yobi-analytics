import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "../../src/index.css"
import "../../src/styles/dashboard.css"
import { DashboardCanonicalEditor } from "../../src/components/DashboardCanonicalEditor"
import type { CanonicalLayout } from "../../src/types/dashboardLayout"

/** MT-16/MT-17 browser-verification-only mount point. Not part of the app's
 * own routing (`App.tsx`/`useCurrentPage.ts`): `DashboardCanonicalEditor`
 * is deliberately not wired into `DashboardPage.tsx` yet (see that
 * component's own module docstring), so this Vite multi-entry HTML page
 * (`canonical-dashboard-harness.html`, served automatically by `vite dev`
 * alongside `index.html` -- no routing/build config change needed) is the
 * smallest way to reach it from a real browser. Imports the real
 * `index.css`/`dashboard.css` the production app also loads (`main.tsx`),
 * so computed styles here (used for AC7's focus evidence) are genuine.
 *
 * Fixture: three same-height 1-wide widgets in a row, wide enough that
 * every breakpoint reflows differently (desktop: all three side by side;
 * tablet, capped at 2 columns: two side by side plus one on a new row;
 * mobile: one per row) -- see `dashboardResponsive.ts`. This is deliberately
 * not the shared 2x2 A/B/C/D fixture: that fixture's tablet reflow is
 * identical to its desktop one (it already fits 2 columns), which would
 * not exercise a real per-breakpoint difference.
 */
const FIXTURE_LAYOUT: CanonicalLayout = {
  grid: { columns: 3, rows: 1 },
  widgets: [
    { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
    { widgetId: "c", widgetType: "growth-bar-chart", x: 2, y: 0, width: 1, height: 1 },
  ],
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DashboardCanonicalEditor layout={FIXTURE_LAYOUT} />
  </StrictMode>,
)
