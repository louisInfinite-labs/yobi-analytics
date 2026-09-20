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
import { reflowLayoutForBreakpoint } from "./dashboardResponsive"
import { validateLayout } from "./dashboardLayoutValidation"
import type { CanonicalLayout, DashboardWidget, LayoutValidationError } from "../model/dashboardLayout"

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

/** The former canonical grid maximum (1x1-5x5). Exists ONLY so a
 * payload persisted under that older contract can be recognized and
 * recovered; it is never a valid current-layout bound (`GridDimension` /
 * `validateLayout` stop at 3). */
export const LEGACY_MAX_GRID = 5

/** The current product maximum a legacy layout is converted to. */
const CURRENT_MAX_GRID = 3

/** A persisted layout whose grid was legal under the former 1x1-5x5
 * contract: same shape as `CanonicalLayout`, but its grid dimensions are
 * plain numbers (they may exceed the current `GridDimension` range). */
export interface LegacyGridLayout {
  grid: { columns: number; rows: number }
  widgets: DashboardWidget[]
}

/** True only for an "old-valid grid-size issue": the sole reasons the
 * current validator rejects the payload are `INVALID_GRID_SIZE` (with both
 * dimensions integers in the old 1..LEGACY_MAX_GRID range and at least one
 * above the current maximum) and, optionally, `DUPLICATE_WIDGET_ID`. Any
 * other error -- overlap, bad height/width/coordinates, incomplete fill --
 * is independent corruption and is never mislabeled as legacy. */
export function isLegacyGridPayload(layout: CanonicalLayout, errors: LayoutValidationError[]): boolean {
  const { columns, rows } = layout.grid
  const inLegacyRange = (value: number) => Number.isInteger(value) && value >= 1 && value <= LEGACY_MAX_GRID
  if (!inLegacyRange(columns) || !inLegacyRange(rows)) return false
  if (Math.max(columns, rows) <= CURRENT_MAX_GRID) return false
  if (!errors.some((error) => error.code === "INVALID_GRID_SIZE")) return false
  return errors.every((error) => error.code === "INVALID_GRID_SIZE" || error.code === "DUPLICATE_WIDGET_ID")
}

function withoutGeometry(widget: DashboardWidget): string {
  const copy: Record<string, unknown> = { ...widget }
  delete copy.x
  delete copy.y
  delete copy.width
  return JSON.stringify(copy)
}

/** Every widget survives with identical id, type, height and every other
 * field except geometry (`x`, `y`, `width`). */
function preservesEveryWidget(legacy: LegacyGridLayout, candidate: CanonicalLayout): boolean {
  if (legacy.widgets.length !== candidate.widgets.length) return false
  const byId = new Map(candidate.widgets.map((widget) => [widget.widgetId, widget]))
  if (byId.size !== legacy.widgets.length) return false
  return legacy.widgets.every((original) => {
    const migrated = byId.get(original.widgetId)
    return migrated !== undefined && withoutGeometry(original) === withoutGeometry(migrated)
  })
}

/** The lossless <=3x3 migration candidate for a legacy layout, or
 * `null` when none can be produced without deleting a widget, changing a
 * height, or renaming an id. Pure -- nothing is persisted here. Tried in
 * order, each gated by the single canonical `validateLayout`:
 *   1. declared-grid trim: widgets untouched, each grid dimension clamped
 *      to the current maximum (works only if every widget already fits);
 *   2. deterministic repack: the responsive shelf reflow at the current
 *      maximum width (known not to produce a valid layout for some stacked
 *      0.5X arrangements -- those simply return `null`).
 * Widget array order is preserved so nothing about identity or ordering
 * changes beyond geometry. */
export function proposeLegacyMigration(legacy: LegacyGridLayout): CanonicalLayout | null {
  const ids = legacy.widgets.map((widget) => widget.widgetId)
  if (new Set(ids).size !== ids.length) return null // ids cannot be preserved AND made unique

  const clamp = (value: number) => Math.min(CURRENT_MAX_GRID, Math.max(1, value)) as CanonicalLayout["grid"]["columns"]
  const trimmed: CanonicalLayout = {
    grid: { columns: clamp(legacy.grid.columns), rows: clamp(legacy.grid.rows) },
    widgets: legacy.widgets.map((widget) => ({ ...widget })),
  }
  if (validateLayout(trimmed).valid && preservesEveryWidget(legacy, trimmed)) return trimmed

  const reflowed = reflowLayoutForBreakpoint(legacy as unknown as CanonicalLayout, "desktop", CURRENT_MAX_GRID)
  if (Math.ceil(reflowed.rows) > CURRENT_MAX_GRID) return null
  const placed = new Map(reflowed.widgets.map((widget) => [widget.widgetId, widget]))
  const repacked: CanonicalLayout = {
    grid: { columns: clamp(reflowed.columns), rows: clamp(Math.ceil(reflowed.rows)) },
    widgets: legacy.widgets.map((widget) => ({ ...(placed.get(widget.widgetId) ?? widget) })),
  }
  if (validateLayout(repacked).valid && preservesEveryWidget(legacy, repacked)) return repacked
  return null
}
