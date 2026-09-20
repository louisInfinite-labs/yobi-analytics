/** Production catalog-driven canonical Add Widget UI.
 *
 * `computeRowInsertionPreview` (dashboardInsertionPreview.ts) only computes
 * a correct result for a row of unit-width (`width: 1`), unit-height
 * (`height: 1`) widgets that all share one `y` -- it repositions every row
 * member to an integer `x` by index, which is wrong for a widget wider than
 * one column. This finds which rows of a real layout are actually safe
 * insertion targets under that constraint, so the production Add UI never
 * offers a slot that would silently misplace a wider widget. This is a pure
 * grouping query -- it decides nothing about validity beyond that structural
 * precondition; `validateLayout` (via `addWidgetAtSlot`) still owns whether
 * a chosen slot's resulting layout is accepted.
 */
import type { CanonicalLayout, DashboardWidget } from "../types/dashboardLayout"

export interface InsertableRow {
  /** The row's shared `y`, used only to identify/label the row -- callers
   * pass `widgets` straight through to `addWidgetAtSlot`/
   * `computeRowInsertionPreview` and never need to reconstruct it. */
  y: number
  /** Every widget in the row, left to right (`x` ascending). */
  widgets: DashboardWidget[]
}

/** Groups `layout`'s widgets by `y` and keeps only rows where every widget
 * is a unit-width, unit-height (`1x1`) widget -- the shape
 * `computeRowInsertionPreview` supports. A row containing a wider or
 * `0.5X` widget is left out entirely rather than partially targeted, since
 * this function has no way to safely re-flow a non-uniform row. Rows are
 * returned sorted by `y`; an empty layout returns no rows. */
export function findInsertableRows(layout: CanonicalLayout): InsertableRow[] {
  const byY = new Map<number, DashboardWidget[]>()
  for (const widget of layout.widgets) {
    const row = byY.get(widget.y) ?? []
    row.push(widget)
    byY.set(widget.y, row)
  }

  const rows: InsertableRow[] = []
  for (const [y, widgets] of byY.entries()) {
    if (widgets.some((widget) => widget.width !== 1 || widget.height !== 1)) continue
    rows.push({ y, widgets: [...widgets].sort((a, b) => a.x - b.x) })
  }
  return rows.sort((a, b) => a.y - b.y)
}
