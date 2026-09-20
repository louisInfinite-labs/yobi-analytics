/** MT-03 "Default 2x2 Layout and Saved-Layout Priority"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 3.1).
 *
 * Builds the product-defined default canonical layout and decides whether a
 * Dashboard should render that default or a previously saved layout.
 * Widgets are created with MT-02's `createWidget` (same `widgetId`
 * generation as the production Add path) and the default is validated with
 * MT-01's `validateLayout` in this module's own test, so defaults are held
 * to the same identity/validation contract as user-added widgets (Section
 * 3.1: "Default widgets must have unique widgetId values and must pass the
 * same validation as user-added widgets.").
 *
 * `resolveInitialLayout` takes the saved layout as a plain, already-typed
 * input rather than reading from or validating untrusted storage itself.
 * The actual persistence boundary -- reading raw storage, validating
 * untrusted/legacy data, and recovering from an invalid save -- is owned by
 * MT-15 ("Persistence, Legacy Layout, and Reload"), not MT-03: MT-03's own
 * dependencies are only MT-01 and MT-02.
 */
import { createWidget } from "./dashboardWidgetActions"
import type { CanonicalLayout, DashboardWidget, GridSize } from "../model/dashboardLayout"

export const DEFAULT_GRID: GridSize = { columns: 2, rows: 2 }

/** Explicit default configuration (Section 3.1): fixed widget types,
 * positions, and order. Independent of the chart catalog (loaded later by
 * MT-04) and never reordered by backend response order. */
export const DEFAULT_WIDGET_CONFIG: ReadonlyArray<
  Pick<DashboardWidget, "widgetType" | "x" | "y" | "width" | "height">
> = [
  { widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
  { widgetType: "growth-bar-chart", x: 1, y: 0, width: 1, height: 1 },
  { widgetType: "contribution-ring", x: 0, y: 1, width: 1, height: 1 },
  { widgetType: "ranking", x: 1, y: 1, width: 1, height: 1 },
]

/** Builds a fresh default layout with unique `widgetId`s, one per
 * `DEFAULT_WIDGET_CONFIG` entry in its declared order. */
export function buildDefaultLayout(): CanonicalLayout {
  const widgets = DEFAULT_WIDGET_CONFIG.map(({ widgetType, ...placement }) => createWidget(widgetType, placement))
  return { grid: DEFAULT_GRID, widgets }
}

/** Section 3.1: "A valid saved user layout takes precedence over the
 * default. Loading the page must not overwrite it with 2x2." `savedLayout`
 * is `null` when nothing has been saved yet; any other value is returned
 * exactly as given; validating/recovering untrusted saved data is MT-15's
 * job, not this function's. */
export function resolveInitialLayout(savedLayout: CanonicalLayout | null): CanonicalLayout {
  return savedLayout ?? buildDefaultLayout()
}
