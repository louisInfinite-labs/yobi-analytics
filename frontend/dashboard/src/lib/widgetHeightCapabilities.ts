/** GAP-2E "Enforce Widget-Specific Height Capabilities in Canonical Mutations".
 *
 * The single, non-React source of truth for GAP-2D's per-widget-type
 * `allowedHeights` data. Extracted out of `widgetRegistry.tsx` (a `.tsx`
 * module that imports React and every chart component) specifically so the
 * canonical mutation layer (`dashboardWidgetActions.ts`, a plain-data
 * module with no React dependency) can enforce it without pulling
 * React/recharts/every chart component into otherwise pure canonical-state
 * logic. `widgetRegistry.tsx`'s own `WidgetDefinition.allowedHeights` field
 * (GAP-2D) reads from this same constant rather than restating it, so
 * there remains exactly one copy of these values.
 *
 * A widgetType with no entry here (e.g. the comparison widget type,
 * `COMPARISON_WIDGET_TYPE` in dashboardComparisonWidgets.ts, or any future
 * catalog-driven type) is deliberately unrestricted -- GAP-2D only defined
 * evidence-backed constraints for the six current production widget types;
 * inventing a restriction for anything else is out of scope.
 */
import type { WidgetHeight } from "../types/dashboardLayout"
import type { WidgetTypeId } from "../types/widget"

export const WIDGET_ALLOWED_HEIGHTS: Record<WidgetTypeId, WidgetHeight[]> = {
  "kpi-summary": [0.5, 1],
  "growth-bar-chart": [1],
  "contribution-ring": [1],
  ranking: [0.5, 1],
  insights: [0.5, 1],
  "video-stats-table": [0.5, 1],
}

/** True when `widgetType` has no GAP-2D entry (unrestricted) or `height` is
 * one of its listed `allowedHeights`. */
export function isAllowedWidgetHeight(widgetType: string, height: number): boolean {
  if (!Object.hasOwn(WIDGET_ALLOWED_HEIGHTS, widgetType)) return true
  return WIDGET_ALLOWED_HEIGHTS[widgetType as WidgetTypeId].includes(height as WidgetHeight)
}
