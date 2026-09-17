/** MT-08 "Widget Insertion-Slot Preview"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 7).
 *
 * Computes the row-major insertion of one candidate widget into an
 * existing single-row layout of unit-width, unit-height widgets, exactly
 * matching Section 7.1/7.2's worked example (`A | B` -> `A | E | B` or
 * `A | B | E`): every widget in the row narrows to fit the expanded grid,
 * left to right, in the new order. This is the scope MT-08's acceptance
 * criteria actually test; a multi-row layout with untouched other rows
 * (Section 7.3's "if the underlying grid changes other rows, the preview
 * must show all affected widgets") is not exercised by any MT-08 criterion
 * and is not generalized to here.
 *
 * Reuses the canonical `validateLayout` (MT-01) as the single source of
 * truth for rejecting a slot that cannot fit -- Section 7.3: "Reject an
 * insertion slot when the new widget cannot fit without overlap,
 * clipping, or an invalid size." This function only *computes* a
 * candidate layout; it never decides validity itself.
 */
import type { CanonicalLayout, DashboardWidget, GridDimension } from "../types/dashboardLayout"

export interface InsertionCandidate {
  widgetId: string
  widgetType: string
}

/** `slotIndex` is a row-major insertion index: `0` places the candidate
 * before the first existing widget, `existingRow.length` places it after
 * the last. Returns a new layout with `grid.columns` widened by one and
 * every widget in `existingRow` (assumed left-to-right, unit width, `y: 0`,
 * `height: 1`) repositioned to its new integer column -- deliberately
 * unclamped to the `1x1`-`5x5` range: `validateLayout` (Section 10) is the
 * single canonical place that range is enforced, not this function. */
export function computeRowInsertionPreview(
  baseLayout: CanonicalLayout,
  existingRow: DashboardWidget[],
  candidate: InsertionCandidate,
  slotIndex: number,
): CanonicalLayout {
  const ordered = [...existingRow].sort((a, b) => a.x - b.x)
  const candidateWidget: DashboardWidget = { widgetId: candidate.widgetId, widgetType: candidate.widgetType, x: 0, y: 0, width: 1, height: 1 }
  const newOrder = [...ordered.slice(0, slotIndex), candidateWidget, ...ordered.slice(slotIndex)]
  const widgets = newOrder.map((widget, index) => ({ ...widget, x: index, y: 0 }))

  return {
    grid: { ...baseLayout.grid, columns: widgets.length as GridDimension },
    widgets,
  }
}
