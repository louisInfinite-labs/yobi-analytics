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
 * A widgetType with no entry here (e.g. any future catalog-driven type) is
 * deliberately unrestricted -- GAP-2D only defined evidence-backed
 * constraints for the six current production widget types; inventing a
 * restriction for anything else is out of scope.
 */
import type { WidgetHeight } from "../model/dashboardLayout"
import type { WidgetTypeId } from "../model/widget"

export const WIDGET_ALLOWED_HEIGHTS: Record<WidgetTypeId, WidgetHeight[]> = {
  // Two rows of filter controls (organization + metric) before any ranked
  // row is visible at all -- 0.5X leaves no usable room underneath them.
  "subscriber-leaderboard": [1],
  // Only one control row (metric); still usable cramped, same reasoning
  // the old `ranking`/`insights` types had for allowing 0.5X.
  "creator-video-ranking": [0.5, 1],
}

/** True when `widgetType` has no GAP-2D entry (unrestricted) or `height` is
 * one of its listed `allowedHeights`. */
export function isAllowedWidgetHeight(widgetType: string, height: number): boolean {
  if (!Object.hasOwn(WIDGET_ALLOWED_HEIGHTS, widgetType)) return true
  return WIDGET_ALLOWED_HEIGHTS[widgetType as WidgetTypeId].includes(height as WidgetHeight)
}
