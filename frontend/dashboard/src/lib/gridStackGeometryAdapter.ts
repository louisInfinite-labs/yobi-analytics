/** GridStack <-> canonical geometry adapter
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 0.1: "GridStack's
 * current 12-column representation is an implementation detail ... Any
 * GridStack adapter must translate to and from canonical layout data and run
 * the canonical validator.").
 *
 * Pure geometry translation only. This module does not read or write
 * CanonicalLayout state, does not call validateLayout/dashboardWidgetActions
 * itself, and is not wired into the live GridStack runtime
 * (../components/DashboardGrid.tsx, ../hooks/useEditableLayout.ts) -- that
 * remains on its separate legacy 12-column/instanceId model (WidgetInstance
 * in ../types/widget.ts) until a later microtask assigns that wiring.
 *
 * GridStack's own node model only supports integer x/y/w/h -- there is no
 * native fractional row unit. Canonical row units (`y`, `height`) are always
 * an integer or an exact half (dashboardLayoutValidation.ts's
 * `isHalfRowAligned`), so scaling every canonical row unit by
 * GRIDSTACK_ROW_SCALE before handing it to GridStack is lossless: `1X` becomes
 * 2 GridStack rows, `0.5X` becomes 1 GridStack row, and every canonical `y`
 * lands on an integer GridStack row. Columns need no such scale: canonical
 * `width`/`x` are already integers 1-3, and GridStack's `column` option
 * accepts any positive integer, so this adapter configures GridStack with
 * exactly the canonical column count instead of the unrelated hardcoded `12`
 * that the current DashboardGrid.tsx instance happens to use.
 *
 * It also provides `minGridStackHeightForAllowedHeights` (see its own doc
 * comment): the legacy per-widget `minH` values are unit-incompatible with
 * `GRIDSTACK_ROW_SCALE`. Geometry translation itself is unchanged.
 */

import type { DashboardWidget, GridSize, WidgetHeight } from "../types/dashboardLayout"

/** One canonical row unit (`1X`) equals this many GridStack integer rows. */
export const GRIDSTACK_ROW_SCALE = 2

/** Min-size integration. The legacy `WidgetSizeLimits.minH`
 * values in `widgetRegistry.tsx` were authored for the old 12-column,
 * arbitrary-integer-height GridStack model and are incompatible with
 * `GRIDSTACK_ROW_SCALE` (e.g. `growth-bar-chart`'s legacy `minH: 3` would
 * force a canonical `1X` widget -- 2 GridStack rows -- to be clamped to 3,
 * visibly taller than its own canonical height). The correct GridStack-scale
 * minimum height is derived from the widget's own
 * `allowedHeights` (already-existing canonical capability data,
 * `widgetRegistry.tsx`'s `WidgetDefinition.allowedHeights` /
 * `widgetHeightCapabilities.ts`'s `WIDGET_ALLOWED_HEIGHTS`) instead: the
 * smallest legal canonical height for that widget type, scaled the same way
 * any other canonical height is. This does not duplicate or reinterpret
 * `allowedHeights` -- the widget capability metadata remains its sole owner -- and introduces no
 * per-widget minimum *width*: the canonical model has no such concept
 * (`validateWidths` only enforces a generic 1-column floor, which is already
 * GridStack's own unconfigured default), so none is derived here. */
export function minGridStackHeightForAllowedHeights(allowedHeights: readonly WidgetHeight[]): number {
  return Math.min(...allowedHeights) * GRIDSTACK_ROW_SCALE
}

/** The GridStack node shape this adapter produces/consumes: `id` carries the
 * canonical `widgetId` as GridStack's item identity (its `gs-id`) -- no
 * separate instanceId is introduced. */
export interface GridStackWidgetNode {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export type GridStackNodeGeometry = Pick<GridStackWidgetNode, "x" | "y" | "w" | "h">

/** A candidate canonical geometry produced from a GridStack node. Callers
 * pass its `x`/`y` into moveWidget or its `width`/`height` into resizeWidget
 * (dashboardWidgetActions.ts) -- this module never calls them itself, so
 * validateLayout plus the per-widget-type capability check remains the sole commit gate. */
export interface CanonicalGeometryCandidate {
  widgetId: string
  widgetType: string
  x: number
  y: number
  width: number
  height: WidgetHeight
}

/** Canonical -> GridStack: deterministic, per-widget geometry translation for
 * rendering. Preserves `widgetId` as the GridStack identity. */
export function canonicalWidgetToGridStackNode(widget: DashboardWidget): GridStackWidgetNode {
  return {
    id: widget.widgetId,
    x: widget.x,
    y: widget.y * GRIDSTACK_ROW_SCALE,
    w: widget.width,
    h: widget.height * GRIDSTACK_ROW_SCALE,
  }
}

/** The GridStack `column` option value for a canonical grid: canonical
 * column counts map 1:1, so no separate column scale constant is needed. */
export function canonicalGridToGridStackColumnCount(grid: GridSize): number {
  return grid.columns
}

/** A raw GridStack row height (post row-scale division) snaps to whichever
 * legal canonical unit it is closer to. `0.75` is the exact midpoint between
 * `0.5` and `1`, so it snaps to `1`; this only matters for a node that never
 * came from this adapter's own canonicalWidgetToGridStackNode output, since
 * every value that did is already an exact `0.5` or `1` after division. */
function snapToCanonicalHeight(rawHeight: number): WidgetHeight {
  return rawHeight >= 0.75 ? 1 : 0.5
}

/** GridStack -> Canonical candidate: translates a GridStack node emitted by
 * the runtime back into a canonical geometry candidate, preserving the
 * caller-supplied `widgetId`/`widgetType` (GridStack nodes carry no widget
 * type). Does not mutate any layout and does not call dashboardWidgetActions
 * or validateLayout -- the caller is responsible for feeding the resulting
 * `x`/`y` or `width`/`height` into moveWidget/resizeWidget, whose existing
 * validateCandidate call (validateLayout + isAllowedWidgetHeight)
 * remains the only place an unsupported result is rejected. */
export function gridStackNodeToCanonicalCandidate(
  node: GridStackNodeGeometry,
  widgetId: string,
  widgetType: string,
): CanonicalGeometryCandidate {
  return {
    widgetId,
    widgetType,
    x: node.x,
    y: node.y / GRIDSTACK_ROW_SCALE,
    width: node.w,
    height: snapToCanonicalHeight(node.h / GRIDSTACK_ROW_SCALE),
  }
}
