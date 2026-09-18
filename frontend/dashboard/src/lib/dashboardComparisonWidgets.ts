/** MT-11 "Flow 1: In-Widget Creator Picker"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 3.4 Flow 1;
 * DASHBOARD_LAYOUT_IMPLEMENTATION_TASKS.md MT-11).
 *
 * Marks which `widgetType` values are comparison-capable and applies a
 * confirmed creator selection (MT-10's ordered-selection output) to exactly
 * one widget's `comparison` config within a layout. No chart-catalog/backend
 * concept of "comparison-capable" exists yet (GAP-2/GAP-3 remain unresolved
 * per DASHBOARD_LAYOUT_IMPLEMENTATION_TASKS.md's MT-04 section), so
 * `COMPARISON_WIDGET_TYPE` is this microtask's own local marker -- the same
 * role `DEFAULT_WIDGET_CONFIG`'s widgetType strings (dashboardDefaultLayout.ts)
 * already play for the default layout: an arbitrary stable string
 * identifier, not a catalog-driven property. Wiring real catalog-driven
 * compatibility detection is left to whoever resolves GAP-2/GAP-3.
 */
import { dedupePreservingOrder } from "./creatorComparisonOrder"
import type { CanonicalLayout, CreatorComparisonConfig, DashboardWidget } from "../types/dashboardLayout"

export const COMPARISON_WIDGET_TYPE = "creator-comparison-chart"

/** MT-11 AC1's "compatible chart": presently keyed on `widgetType` alone.
 * Any widget of a different type is incompatible and must never receive a
 * `comparison` config (AC1: "must not silently receive comparison
 * configuration"). */
export function isComparisonCapableWidget(widget: DashboardWidget): boolean {
  return widget.widgetType === COMPARISON_WIDGET_TYPE
}

/** MT-11 AC4-AC7: replaces exactly one compatible widget's
 * `comparison.creatorIds` with `creatorIds` (deduplicated, order preserved),
 * leaving every other widget -- and every other field of the target widget
 * itself, including `widgetId`, `x`, `y`, `width`, `height`, and any existing
 * `comparisonItemIds` -- untouched. Every non-matching widget is returned by
 * reference, unchanged, from the same `.map` call that produces the new
 * `widgets` array, so an unrelated widget is not merely deep-equal but
 * strictly `===` its pre-call self.
 *
 * A `widgetId` that doesn't exist, or that isn't comparison-capable, leaves
 * `layout` completely unchanged -- the same "reject silently, no partial
 * mutation" convention `dashboardWidgetActions.ts`'s geometry mutations
 * already use -- which is what keeps an incompatible widget from ever
 * silently receiving comparison configuration (AC1) even if a caller
 * mistakenly targets one. */
export function applyCreatorComparisonSelection(
  layout: CanonicalLayout,
  widgetId: string,
  creatorIds: readonly string[],
): CanonicalLayout {
  const target = layout.widgets.find((widget) => widget.widgetId === widgetId)
  if (!target || !isComparisonCapableWidget(target)) return layout

  const nextComparison: CreatorComparisonConfig = {
    creatorIds: dedupePreservingOrder(creatorIds),
    comparisonItemIds: target.comparison?.comparisonItemIds ?? [],
  }

  return {
    ...layout,
    widgets: layout.widgets.map((widget) => (widget.widgetId === widgetId ? { ...widget, comparison: nextComparison } : widget)),
  }
}
