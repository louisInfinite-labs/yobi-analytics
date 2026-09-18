/** MT-15 "Persistence, Legacy Layout, and Reload"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 10: "An
 * invalid legacy layout must enter a recoverable error or an explicit,
 * tested migration. Do not silently render overlapping widgets.").
 *
 * Two narrow, composable pieces the production load path
 * (`dashboardCanonicalLayoutStore.ts`) builds its recovery decision from:
 * a runtime shape guard for untrusted parsed JSON, and the one migration
 * this microtask implements (duplicate `widgetId`s -- MT-15 AC3/AC5).
 * `WIDGET_OVERLAP` and every other `validateLayout` failure are
 * deliberately not migrated here: Section 8 rule 8 ("Never delete, hide, or
 * overlap widgets to force the layout to fit") already forbids the store
 * from auto-repositioning or auto-resizing widgets to resolve an overlap,
 * so overlapping legacy data is non-migratable by design and is the
 * store's recoverable-error path (AC4/AC6), not a second migration here.
 */
import { createWidgetId } from "./dashboardWidgetActions"
import type { CanonicalLayout } from "../types/dashboardLayout"

function isDashboardWidgetShape(value: unknown): value is CanonicalLayout["widgets"][number] {
  if (typeof value !== "object" || value === null) return false
  const widget = value as Record<string, unknown>
  return (
    typeof widget.widgetId === "string" &&
    typeof widget.widgetType === "string" &&
    typeof widget.x === "number" &&
    typeof widget.y === "number" &&
    typeof widget.width === "number" &&
    typeof widget.height === "number"
  )
}

/** Guards untrusted parsed JSON against the canonical layout's basic shape
 * (field presence/types only -- `validateLayout` owns every semantic rule:
 * grid range, duplicate ids, collisions, bounds, and fill). Data that fails
 * this guard is corrupt/foreign rather than a recognizable legacy shape, so
 * the store treats it as non-migratable. */
export function isCanonicalLayoutShape(value: unknown): value is CanonicalLayout {
  if (typeof value !== "object" || value === null) return false
  const layout = value as Record<string, unknown>
  const grid = layout.grid as Record<string, unknown> | undefined
  if (typeof grid !== "object" || grid === null) return false
  if (typeof grid.columns !== "number" || typeof grid.rows !== "number") return false
  if (!Array.isArray(layout.widgets)) return false
  return layout.widgets.every(isDashboardWidgetShape)
}

/** MT-15 AC3/AC5: every `widgetId` after its first occurrence is reassigned
 * a fresh id via `createWidgetId` (MT-02's own id generation, not a second
 * one) so the result can never contain duplicates. The first occurrence of
 * a given id is left untouched -- an explicit, deterministic choice about
 * which of two colliding legacy records "wins" the original identity, not
 * an arbitrary one. Every other field is preserved unchanged. */
export function migrateDuplicateWidgetIds(layout: CanonicalLayout): CanonicalLayout {
  const seenIds = new Set<string>()
  const widgets = layout.widgets.map((widget) => {
    if (!seenIds.has(widget.widgetId)) {
      seenIds.add(widget.widgetId)
      return widget
    }
    return { ...widget, widgetId: createWidgetId(widget.widgetType) }
  })
  return { ...layout, widgets }
}
