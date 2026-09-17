import type { GridChangeConfirmation } from "../hooks/useDashboardEditor"

interface GridChangeConfirmationDialogProps {
  confirmation: GridChangeConfirmation
  /** True when the draft currently fails canonical validation (e.g. the
   * target grid has insufficient capacity) -- Section 8.7/MT-09 AC9:
   * "disable confirmation and explain the problem." */
  disabled: boolean
  onCancel: () => void
  onConfirm: () => void
}

/** MT-09 "Grid-Change Confirmation and Atomic Save" (Section 8). Follows
 * this project's existing hand-rolled dialog convention (backdrop +
 * `role="dialog"` `aria-modal`, a secondary Cancel and a primary confirm
 * action -- see `OshiSwitchConfirmDialog`/`VideoPlayerModal`) since no
 * shared, generic Dialog/Modal component exists to reuse instead (Section
 * 0: "If none exists, follow the convention already used by the
 * surrounding feature"). Deliberately does not implement focus-trapping,
 * `Escape`-to-close, or focus restoration on close: those are explicit
 * MT-16 acceptance criteria ("Dialog focus is trapped and Escape closes
 * it", "Closing a dialog returns focus to its triggering control"), not
 * MT-09's. */
export function GridChangeConfirmationDialog({ confirmation, disabled, onCancel, onConfirm }: GridChangeConfirmationDialogProps) {
  const { currentGrid, targetGrid, affectedWidgetIds } = confirmation
  const currentGridLabel = `${currentGrid.columns}x${currentGrid.rows}`
  const targetGridLabel = `${targetGrid.columns}x${targetGrid.rows}`

  return (
    <div
      className="grid-change-confirmation__backdrop"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Save layout changes?"
    >
      <div className="grid-change-confirmation__panel" onClick={(event) => event.stopPropagation()}>
        <p className="grid-change-confirmation__message">
          The grid will change from <span data-testid="current-grid">{currentGridLabel}</span> to{" "}
          <span data-testid="target-grid">{targetGridLabel}</span>. The system will resize or reposition{" "}
          <span data-testid="affected-widget-count">{affectedWidgetIds.length}</span> existing widget
          {affectedWidgetIds.length === 1 ? "" : "s"}. Review before continuing.
        </p>
        <div className="grid-change-confirmation__actions">
          <button type="button" className="soft-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="soft-button" onClick={onConfirm} disabled={disabled}>
            Continue and Save
          </button>
        </div>
      </div>
    </div>
  )
}
