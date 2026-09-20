import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "../../src/app/styles/index.css"
import "../../src/features/dashboard/styles/dashboard.css"
import { DashboardCanonicalEditor } from "../../src/features/dashboard/editor/components/DashboardCanonicalEditor"
import { COMPARISON_WIDGET_TYPE } from "../../src/features/dashboard/comparison/utils/dashboardComparisonWidgets"
import { mockCreators } from "../../src/entities/creator/data/mockCreators"
import type { CanonicalLayout } from "../../src/features/dashboard/editor/model/dashboardLayout"

/** MT-16 AC7 correction: a separate harness page (never
 * `canonical-dashboard-harness.html`, whose fixture and geometry
 * `mt16-breakpoints.spec.ts`'s AC3 evidence already depends on) whose sole
 * purpose is rendering a comparison-capable widget so the conditional
 * "Select Creators" action (MT-11 Flow 1) actually exists in the DOM for a
 * real focus check. `showComparisonAction` (DashboardCanonicalEditor.tsx)
 * requires edit mode, a `COMPARISON_WIDGET_TYPE` widget, and a supplied
 * `comparisonCreators` array -- all three are met here; `mockCreators` is
 * this project's own existing Creator List data, not invented fixture
 * data.
 */
const FIXTURE_LAYOUT: CanonicalLayout = {
  grid: { columns: 1, rows: 1 },
  widgets: [{ widgetId: "comparison-widget", widgetType: COMPARISON_WIDGET_TYPE, x: 0, y: 0, width: 1, height: 1 }],
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DashboardCanonicalEditor layout={FIXTURE_LAYOUT} comparisonCreators={mockCreators.slice(0, 3)} />
  </StrictMode>,
)
