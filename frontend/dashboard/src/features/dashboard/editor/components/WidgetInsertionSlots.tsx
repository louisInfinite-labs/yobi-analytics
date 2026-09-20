import { Fragment } from "react"
import { getWidgetDefinition, isKnownWidgetType } from "../utils/widgetRegistry"
import type { InsertableRow } from "../utils/dashboardInsertionRows"
import type { DashboardWidget } from "../model/dashboardLayout"

interface WidgetInsertionSlotsProps {
  /** The widget type pending insertion -- shown only for labeling; the
   * candidate widget itself is created by `addWidgetAtSlot`, not here. */
  pendingTitle: string
  rows: InsertableRow[]
  /** `rowNumber` is the same 1-based row label already rendered
   * beside the slot ("Row N") -- passed through so the caller's insertion
   * announcement can reuse it without recomputing row position separately.
   * Selecting a slot now only activates its preview; `onInsert`
   * commits it. */
  onSelectSlot: (row: DashboardWidget[], slotIndex: number, rowNumber: number) => void
  onCancel: () => void
  /** The slot whose preview is currently shown, identified the same
   * way the caller stores it (the row's `y` plus the slot index). */
  activeSlot: { rowY: number; slotIndex: number } | null
  /** Concise status for the active preview (`null` when none). */
  previewStatus: string | null
  /** Commits exactly the active preview; the button is disabled
   * whenever `canInsert` is false. */
  canInsert: boolean
  onInsert: () => void
  /** Set after the most recently attempted slot was rejected by
   * `addWidgetAtSlot` (AC11: no state changes on rejection) -- distinct
   * from a slot never having been tried yet. */
  rejected: boolean
}

function widgetLabel(widget: DashboardWidget): string {
  return isKnownWidgetType(widget.widgetType) ? getWidgetDefinition(widget.widgetType).title : widget.widgetType
}

/** The explicit slot-picking surface a
 * pending Add selection (`WidgetTray`) needs before anything is written to
 * `draftLayout`. Only rows `findInsertableRows` (dashboardInsertionRows.ts)
 * already confirmed are unit-width/unit-height are offered -- no automatic
 * append, no "first free slot" heuristic; every slot is its own explicit
 * button the user must click. */
export function WidgetInsertionSlots({
  pendingTitle,
  rows,
  onSelectSlot,
  onCancel,
  rejected,
  activeSlot,
  previewStatus,
  canInsert,
  onInsert,
}: WidgetInsertionSlotsProps) {
  const isActive = (rowY: number, slotIndex: number) => activeSlot?.rowY === rowY && activeSlot.slotIndex === slotIndex
  return (
    <div className="widget-insertion-slots card" data-testid="widget-insertion-slots">
      <div className="widget-insertion-slots__header">
        <p className="widget-insertion-slots__hint">
          Choose where to insert <strong>{pendingTitle}</strong>:
        </p>
        <div className="widget-insertion-slots__actions">
          <button type="button" className="soft-button widget-insertion-slots__insert" onClick={onInsert} disabled={!canInsert}>
            Insert here
          </button>
          <button type="button" className="soft-button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
      <p className="widget-insertion-slots__status" data-testid="widget-insertion-preview-status" role="status">
        {previewStatus}
      </p>
      {rejected && (
        <p className="widget-insertion-slots__error" data-testid="widget-insertion-rejected" role="alert">
          That slot can't fit this widget.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="widget-insertion-slots__empty">No row in the current layout can accept a new widget right now.</p>
      ) : (
        rows.map((row, rowIndex) => (
          <div className="widget-insertion-slots__row" key={row.y} data-testid={`widget-insertion-row-${row.y}`}>
            <span className="widget-insertion-slots__row-label">Row {rowIndex + 1}</span>
            <div className="widget-insertion-slots__strip">
              <button
                type="button"
                className={`widget-insertion-slots__slot${isActive(row.y, 0) ? " widget-insertion-slots__slot--active" : ""}`}
                aria-label={`Insert ${pendingTitle} at the start of row ${rowIndex + 1}`}
                aria-pressed={isActive(row.y, 0)}
                onClick={() => onSelectSlot(row.widgets, 0, rowIndex + 1)}
              >
                {isActive(row.y, 0) ? "✓" : "+"}
              </button>
              {row.widgets.map((widget, widgetIndex) => (
                <Fragment key={widget.widgetId}>
                  <span className="widget-insertion-slots__existing">{widgetLabel(widget)}</span>
                  <button
                    type="button"
                    className={`widget-insertion-slots__slot${isActive(row.y, widgetIndex + 1) ? " widget-insertion-slots__slot--active" : ""}`}
                    aria-label={`Insert ${pendingTitle} after ${widgetLabel(widget)} in row ${rowIndex + 1}`}
                    aria-pressed={isActive(row.y, widgetIndex + 1)}
                    onClick={() => onSelectSlot(row.widgets, widgetIndex + 1, rowIndex + 1)}
                  >
                    {isActive(row.y, widgetIndex + 1) ? "✓" : "+"}
                  </button>
                </Fragment>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
