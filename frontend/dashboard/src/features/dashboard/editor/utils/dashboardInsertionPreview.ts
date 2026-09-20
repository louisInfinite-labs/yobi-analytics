/** MT-08 "Widget Insertion-Slot Preview"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 7), extended by
 * the production Add UI to be safe
 * against a layout that has other rows.
 *
 * Computes the row-major insertion of one candidate widget into an existing
 * row of unit-width, unit-height widgets, exactly matching Section 7.1/7.2's
 * worked example (`A | B` -> `A | E | B` or `A | B | E`): every widget in the
 * row narrows to fit the expanded row, left to right, in the new order.
 *
 * correction: the original version hardcoded every output
 * widget's `y` to `0` and returned `widgets: newOrder` alone -- correct only
 * when `existingRow` happens to be literally every widget in `baseLayout`
 * (its own tests and the `useDashboardEditor` tests never
 * exercised anything else, per this function's own now-superseded docstring
 * note that a multi-row layout "is not generalized to here"). Called with a
 * real production layout that has more than one row (e.g. the 2x2 default
 * layout), that version silently dropped every widget not in `existingRow`
 * -- the wrong result, not just an untested one, since the Add UI must
 * target one specific existing row without corrupting the others. This
 * version instead takes `existingRow`'s own `y` (from its first widget, all
 * of which must share it) as the row being edited, and carries every other
 * widget in `baseLayout.widgets` through unchanged. Every existing caller
 * (the existing tests, `useDashboardEditor.beginInsertion`/
 * `previewInsertionAtSlot`/`addWidgetAtSlot`) only ever passes a single-row
 * `baseLayout`, where "every other widget" is empty and behavior is
 * unchanged.
 *
 * Reuses the canonical `validateLayout` (MT-01) as the single source of
 * truth for rejecting a slot that cannot fit -- Section 7.3: "Reject an
 * insertion slot when the new widget cannot fit without overlap,
 * clipping, or an invalid size." This function only *computes* a
 * candidate layout; it never decides validity itself.
 */
import { validateLayout } from "./dashboardLayoutValidation"
import type { CanonicalLayout, DashboardWidget, GridDimension } from "../model/dashboardLayout"

export interface InsertionCandidate {
  widgetId: string
  widgetType: string
}

/** `slotIndex` is a row-major insertion index: `0` places the candidate
 * before the first existing widget, `existingRow.length` places it after
 * the last. Returns a new layout with `grid.columns` widened as needed to
 * fit the target row's new width and every widget in `existingRow` (assumed
 * left-to-right, unit width, unit height, sharing one `y`) repositioned to
 * its new integer column at that same `y` -- deliberately unclamped to the
 * `1x1`-`3x3` range: `validateLayout` (Section 10) is the single canonical
 * place that range is enforced, not this function. Every widget in
 * `baseLayout.widgets` that is not part of `existingRow` (identified by
 * `widgetId`) is carried through to the result unchanged. */
export function computeRowInsertionPreview(
  baseLayout: CanonicalLayout,
  existingRow: DashboardWidget[],
  candidate: InsertionCandidate,
  slotIndex: number,
): CanonicalLayout {
  const rowY = existingRow[0]?.y ?? 0
  const ordered = [...existingRow].sort((a, b) => a.x - b.x)
  const candidateWidget: DashboardWidget = { widgetId: candidate.widgetId, widgetType: candidate.widgetType, x: 0, y: rowY, width: 1, height: 1 }
  const newOrder = [...ordered.slice(0, slotIndex), candidateWidget, ...ordered.slice(slotIndex)]
  const repositionedRow = newOrder.map((widget, index) => ({ ...widget, x: index, y: rowY }))

  const rowWidgetIds = new Set(existingRow.map((widget) => widget.widgetId))
  const otherWidgets = baseLayout.widgets.filter((widget) => !rowWidgetIds.has(widget.widgetId))

  return {
    grid: { ...baseLayout.grid, columns: Math.max(baseLayout.grid.columns, repositionedRow.length) as GridDimension },
    widgets: [...otherWidgets, ...repositionedRow],
  }
}

/** The one computation both the production Add preview (derived in
 * `DashboardPage.tsx`) and the committing `useDashboardEditor.addWidgetAtSlot`
 * run, so a previewed layout and the layout its commit produces can never
 * diverge -- same `computeRowInsertionPreview` result, same canonical
 * `validateLayout` gate. */
export function computeValidatedRowInsertion(
  baseLayout: CanonicalLayout,
  existingRow: DashboardWidget[],
  candidate: InsertionCandidate,
  slotIndex: number,
): { layout: CanonicalLayout; valid: boolean } {
  const layout = computeRowInsertionPreview(baseLayout, existingRow, candidate, slotIndex)
  return { layout, valid: validateLayout(layout).valid }
}
