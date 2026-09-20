/** Live canonical state cutover and GridStack pointer wiring.
 *
 * The one-way, pure render projection from canonical layout state to the
 * legacy `WidgetInstance`-shaped props `DashboardGrid.tsx` already renders.
 * Canonical `CanonicalLayout`/`DashboardWidget` (../types/dashboardLayout.ts)
 * remains the only state DashboardPage.tsx holds; this function is called
 * fresh on every render from that state and its output is never written
 * back into canonical state or persisted anywhere -- DashboardGrid.tsx's own
 * geometry-commit path (dragstop/resizestop) goes through the canonical
 * mutation layer directly (`useDashboardEditor.updateDraftWidget`), never
 * through this projection.
 *
 * Geometry (`x`, `y`, `w`, `h`) is produced by the adapter's
 * `canonicalWidgetToGridStackNode`, the same lossless row-scale translation
 * already proven by that module's round-trip tests -- not reimplemented
 * here.
 *
 * `schemaVersion`/`settings` are sourced only from the real widget registry
 * (`getWidgetDefinition(type).schemaVersion`/`.defaultSettings`), the same
 * source `useEditableLayout.ts`'s own `addWidget` already uses for a brand
 * new instance -- never invented per-projection. Canonical `DashboardWidget`
 * carries no settings field of its own to round-trip, so this is a
 * documented simplification, not data loss: nothing in this codebase lets a
 * user diverge a widget's settings from its registry default today (no
 * settings-editing UI exists), so re-deriving them from the type on every
 * projection is currently lossless in practice, not merely convenient.
 * `updatedAt` has no canonical equivalent either, and unlike
 * `schemaVersion`/`settings` there is no real per-widget source of truth for
 * it in the canonical model at all -- it is set to a single fixed sentinel
 * (`PROJECTION_UPDATED_AT`) rather than `new Date()` so this function stays
 * deterministic for identical input (a real requirement here: DashboardGrid
 * treats an unchanged `widgets` array reference as "nothing to resync").
 * `DashboardGrid.tsx` never reads any of these three fields at runtime (only
 * `instanceId`, `type`, `x/y/w/h`) -- confirmed by inspection -- so their
 * only job is satisfying `WidgetInstance`'s TypeScript shape.
 *
 * A canonical widget whose `widgetType` is neither a registered
 * `WidgetTypeId` nor the comparison chart type (it is projected under
 * its own type string, see `gridWidgetMeta.ts`) is excluded from the
 * projected array rather than rendered with a fabricated definition or
 * thrown on -- `isRenderableGridWidgetType` guards this boundary.
 * Excluding it from *this render projection* does not remove it from
 * canonical state: it remains fully present and editable in
 * `draftLayout`/`layout`, just not represented as a GridStack node.
 *
 * Responsive reflow adds
 * `projectResponsiveLayoutForGridStack`, a second entry point for the exact
 * same per-widget geometry translation, taking a `ResponsiveLayout`
 * (dashboardResponsive.ts's `reflowLayoutForBreakpoint` output: a read-only
 * *display* reflow, `columns`/`rows` as plain numbers rather than the canonical
 * `GridDimension`) instead of a `CanonicalLayout`. This is not a second
 * geometry algorithm -- both entry points call the same
 * `projectWidgetsForGridStack` -- only the input shape differs, because a
 * reflowed layout is deliberately not a `CanonicalLayout` (Section 11: a
 * display transform, never re-validated or saved). See
 * `DashboardPage.tsx`'s own docstring for which entry point is used
 * at which breakpoint/mode.
 */
import { canonicalWidgetToGridStackNode } from "./gridStackGeometryAdapter"
import { getWidgetDefinition, isKnownWidgetType } from "./widgetRegistry"
import { isRenderableGridWidgetType, type GridWidgetInstance } from "./gridWidgetMeta"
import type { CanonicalLayout, DashboardWidget } from "../types/dashboardLayout"
import type { ResponsiveLayout } from "./dashboardResponsive"

/** Inert placeholder: `WidgetInstance.updatedAt` has no canonical source of
 * truth and is never read by `DashboardGrid.tsx`. Fixed (not `new Date()`)
 * so the projection is deterministic for identical input. */
export const PROJECTION_UPDATED_AT = "1970-01-01T00:00:00.000Z"

export interface CanonicalGridProjection {
  /** Render-only, one-way `WidgetInstance[]` for `DashboardGrid`'s existing prop shape. */
  widgets: GridWidgetInstance[]
  /** The GridStack `column` count this projection's geometry was computed for. */
  columns: number
  /** `widgetId`s present in `layout` but excluded from `widgets` because
   * their `widgetType` isn't a registered, renderable `WidgetTypeId`. */
  unrenderableWidgetIds: string[]
}

/** Shared per-widget geometry translation both entry points below use --
 * the single place that calls the adapter's `canonicalWidgetToGridStackNode` and
 * excludes an unrenderable widget type, so a `CanonicalLayout` and a
 * `ResponsiveLayout` are projected identically, never by two diverging
 * implementations. */
function projectWidgetsForGridStack(widgets: readonly DashboardWidget[], columns: number): CanonicalGridProjection {
  const projected: GridWidgetInstance[] = []
  const unrenderableWidgetIds: string[] = []

  for (const widget of widgets) {
    if (!isRenderableGridWidgetType(widget.widgetType)) {
      unrenderableWidgetIds.push(widget.widgetId)
      continue
    }
    const node = canonicalWidgetToGridStackNode(widget)
    const { schemaVersion, defaultSettings } = isKnownWidgetType(widget.widgetType)
      ? getWidgetDefinition(widget.widgetType)
      : { schemaVersion: 1, defaultSettings: {} }
    projected.push({
      instanceId: node.id,
      type: widget.widgetType,
      schemaVersion,
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      settings: defaultSettings,
      updatedAt: PROJECTION_UPDATED_AT,
    })
  }

  return { widgets: projected, columns, unrenderableWidgetIds }
}

/** Deterministic, one-way, non-persistent. Never mutates `layout` and never
 * produces anything callers could write back into canonical state. */
export function projectCanonicalLayoutForGridStack(layout: CanonicalLayout): CanonicalGridProjection {
  return projectWidgetsForGridStack(layout.widgets, layout.grid.columns)
}

/** The same projection for a breakpoint's read-only reflowed
 * display layout (tablet/mobile view mode, or a canonical layout wider than
 * the current breakpoint's editable column cap). `responsive.rows` is
 * unused here, exactly like `CanonicalLayout.grid.rows` above -- GridStack
 * only needs a `column` count; each item's own `y`/`h` already imply how
 * many rows exist. */
export function projectResponsiveLayoutForGridStack(responsive: ResponsiveLayout): CanonicalGridProjection {
  return projectWidgetsForGridStack(responsive.widgets, responsive.columns)
}
