/** MT-02 "Widget Identity and Duplicate Prevention"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 4), extended by
 * MT-05 "Grid Dimensions, Widget Sizes, Fill, and Collision" (AC10-12).
 *
 * The production Add/update/move/resize path for the MT-01 canonical layout
 * model (../types/dashboardLayout.ts). Every mutation here builds a
 * candidate layout and runs it through the canonical `validateLayout`
 * before returning a committed result, so a duplicate `widgetId`, overlap,
 * out-of-bounds placement, or any other invalid outcome never reaches
 * caller state — the input `layout` is returned unchanged instead, which is
 * also what makes a rejected move/resize "restore the last valid draft
 * coordinates" (MT-05 AC11): nothing was ever mutated to roll back from.
 *
 * `moveWidget`/`resizeWidget` are thin, semantically named wrappers around
 * `updateWidgetGeometry` (not a second validation path): a move touches only
 * `x`/`y`, a resize touches only `width`/`height`, and neither ever touches
 * `widgetId` or `widgetType`, which is what preserves identity across a
 * successful call (MT-05 AC12) for free.
 *
 * Deliberately not wired into the live GridStack-backed dashboard
 * (../hooks/useEditableLayout.ts, ../components/DashboardGrid.tsx) yet.
 * That system renders a 12-column grid with arbitrary integer widget
 * heights, a different contract than this module's 1x1-3x3 / 0.5X-1X
 * canonical model; running validateLayout against a literal translation of
 * its current data would reject the existing default layout outright.
 * Guidelines Section 0 treats GridStack as "an implementation detail" and
 * requires that "any GridStack adapter must translate to and from
 * canonical layout data and run the canonical validator" -- building that
 * adapter is not assigned to any microtask in the current task document
 * (MT-05 included) and is not built here.
 */

import { validateLayout } from "./dashboardLayoutValidation"
import { isAllowedWidgetHeight } from "./widgetHeightCapabilities"
import type { CanonicalLayout, DashboardWidget, LayoutValidationError, LayoutValidationResult } from "../model/dashboardLayout"

export type WidgetPlacement = Pick<DashboardWidget, "x" | "y" | "width" | "height">
export type WidgetPosition = Pick<DashboardWidget, "x" | "y">
export type WidgetSize = Pick<DashboardWidget, "width" | "height">

export interface LayoutMutationOutcome {
  layout: CanonicalLayout
  committed: boolean
  result: LayoutValidationResult
}

/** GAP-2E: per-widget-type height capability (widgetHeightCapabilities.ts's
 * WIDGET_ALLOWED_HEIGHTS, GAP-2D's evidence-backed metadata), layered on top
 * of validateLayout's own generic canonical-height-unit check. Reuses the
 * existing INVALID_HEIGHT code -- "this height is invalid for this widget"
 * is the same failure category as "this height is not a legal canonical
 * unit", not a new one. A widgetType with no capability entry (e.g. the
 * comparison widget type) is never restricted here. */
function capabilityErrors(widgets: readonly DashboardWidget[]): LayoutValidationError[] {
  const offending = widgets.filter((widget) => !isAllowedWidgetHeight(widget.widgetType, widget.height))
  if (offending.length === 0) return []
  return [
    {
      code: "INVALID_HEIGHT",
      widgetIds: offending.map((widget) => widget.widgetId),
      message: `Height not supported by widget type: ${offending
        .map((widget) => `${widget.widgetId} (${widget.widgetType} at ${widget.height}X)`)
        .join(", ")}.`,
    },
  ]
}

function validateCandidate(candidate: CanonicalLayout): LayoutValidationResult {
  const result = validateLayout(candidate)
  const extra = capabilityErrors(candidate.widgets)
  if (extra.length === 0) return result
  return { valid: false, errors: [...result.errors, ...extra] }
}

/** Unique per call: matches the existing project convention
 * (see useEditableLayout.ts's addWidget) of a readable `type-uuid` id. */
export function createWidgetId(widgetType: string): string {
  return `${widgetType}-${crypto.randomUUID()}`
}

export function createWidget(widgetType: string, placement: WidgetPlacement): DashboardWidget {
  return { widgetId: createWidgetId(widgetType), widgetType, ...placement }
}

/** Appends `widget` to `layout` and validates the result before commit.
 * Rejects (leaving `layout` untouched) on a duplicate `widgetId` or any
 * other validation failure. */
export function addWidget(layout: CanonicalLayout, widget: DashboardWidget): LayoutMutationOutcome {
  const candidate: CanonicalLayout = { ...layout, widgets: [...layout.widgets, widget] }
  const result = validateCandidate(candidate)
  if (!result.valid) return { layout, committed: false, result }
  return { layout: candidate, committed: true, result }
}

const rectsOverlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

/** A plain move (this patch leaves width/height exactly as they already
 * are) that lands exactly on one other widget's cell may swap that widget
 * into the mover's old position instead of being rejected outright -- an
 * ordinary drag-driven position exchange (left<->right, top<->bottom).
 * Guidelines Section 9's collision rejection is for genuine overlaps; it
 * never addresses two widgets trading places in one gesture, and Section 8
 * already accepts one edit changing more than one widget's geometry
 * atomically (there, a grid-size change; here, a two-widget swap). Both
 * widgets keep their own widgetId (Section 4, rule 2) and the swap is only
 * ever committed if the fully swapped layout itself validates cleanly --
 * this never weakens collision/bounds/height/fill validation, it only tries
 * one additional candidate before giving up. A resize (width or height
 * actually changing) never swaps. */
function tryPositionSwap(layout: CanonicalLayout, original: DashboardWidget, patch: Partial<WidgetPlacement>): LayoutMutationOutcome | null {
  const isResize = (patch.width !== undefined && patch.width !== original.width) || (patch.height !== undefined && patch.height !== original.height)
  if (isResize) return null

  const movedRect = { x: patch.x ?? original.x, y: patch.y ?? original.y, width: original.width, height: original.height }
  const colliding = layout.widgets.filter((w) => w.widgetId !== original.widgetId && rectsOverlap(movedRect, w))
  if (colliding.length !== 1) return null
  const [other] = colliding
  if (other.width !== original.width || other.height !== original.height) return null

  const swapCandidate: CanonicalLayout = {
    ...layout,
    widgets: layout.widgets.map((widget) => {
      if (widget.widgetId === original.widgetId) return { ...widget, ...patch }
      if (widget.widgetId === other.widgetId) return { ...widget, x: original.x, y: original.y }
      return widget
    }),
  }
  const swapResult = validateCandidate(swapCandidate)
  if (!swapResult.valid) return null
  return { layout: swapCandidate, committed: true, result: swapResult }
}

/** Updates only the geometry of the widget matching `widgetId`; every other
 * field, including `widgetId` itself, is left untouched — the basis for
 * move/resize preserving identity (Section 4, rule 2). */
export function updateWidgetGeometry(
  layout: CanonicalLayout,
  widgetId: string,
  patch: Partial<WidgetPlacement>,
): LayoutMutationOutcome {
  const original = layout.widgets.find((w) => w.widgetId === widgetId)
  const candidate: CanonicalLayout = {
    ...layout,
    widgets: layout.widgets.map((widget) => (widget.widgetId === widgetId ? { ...widget, ...patch } : widget)),
  }
  const result = validateCandidate(candidate)
  if (result.valid) return { layout: candidate, committed: true, result }

  const swapOutcome = original && tryPositionSwap(layout, original, patch)
  if (swapOutcome) return swapOutcome

  return { layout, committed: false, result }
}

/** MT-05's production drag path: repositions a widget without touching its
 * size, `widgetId`, or `widgetType`. Rejects (leaving `layout` untouched) on
 * overlap, out-of-bounds placement, or any other validation failure. */
export function moveWidget(layout: CanonicalLayout, widgetId: string, position: WidgetPosition): LayoutMutationOutcome {
  return updateWidgetGeometry(layout, widgetId, position)
}

/** MT-05's production resize path: changes a widget's size without touching
 * its position, `widgetId`, or `widgetType`. Rejects (leaving `layout`
 * untouched) on overlap, out-of-bounds, an unsupported height/width, an
 * incomplete column fill, or any other validation failure. */
export function resizeWidget(layout: CanonicalLayout, widgetId: string, size: WidgetSize): LayoutMutationOutcome {
  return updateWidgetGeometry(layout, widgetId, size)
}

/** Removes the widget matching `widgetId`; every remaining widget is
 * returned byte-for-byte untouched (same array-filter-then-validate shape as
 * `addWidget`'s append, not a second mutation model). Rejects (leaving
 * `layout` untouched) when removal would leave the remaining widgets failing
 * validation -- e.g. removing one of a stacked 0.5X pair leaves an
 * unresolvable `INCOMPLETE_COLUMN` gap. A `widgetId` not present in `layout`
 * is a no-op commit (nothing to remove, nothing to reject). */
export function removeWidget(layout: CanonicalLayout, widgetId: string): LayoutMutationOutcome {
  const candidate: CanonicalLayout = { ...layout, widgets: layout.widgets.filter((widget) => widget.widgetId !== widgetId) }
  const result = validateCandidate(candidate)
  if (!result.valid) return { layout, committed: false, result }
  return { layout: candidate, committed: true, result }
}
