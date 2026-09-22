import { useEffect, useRef } from "react"
import { Button } from "antd"
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

/** MT-09 "Grid-Change Confirmation and Atomic Save" (Section 8), extended by
 * MT-16 "Responsive and Accessibility Verification" (Section 12: "The
 * confirmation dialog must trap focus, support Escape, and return focus to
 * the triggering control" -- MT-16 AC9/AC10). Follows this project's
 * existing hand-rolled dialog convention (backdrop + `role="dialog"`
 * `aria-modal`, a secondary Cancel and a primary confirm action -- see
 * `OshiSwitchConfirmDialog`/`VideoPlayerModal`) since no shared, generic
 * Dialog/Modal component exists to reuse instead (Section 0: "If none
 * exists, follow the convention already used by the surrounding feature").
 * The focus-trap/Escape/restore-focus wiring below is the exact same
 * pattern `OshiSwitchConfirmDialog.tsx` already established -- reused, not
 * reinvented. */
export function GridChangeConfirmationDialog({ confirmation, disabled, onCancel, onConfirm }: GridChangeConfirmationDialogProps) {
  const { currentGrid, targetGrid, affectedWidgetIds } = confirmation
  const currentGridLabel = `${currentGrid.columns}x${currentGrid.rows}`
  const targetGridLabel = `${targetGrid.columns}x${targetGrid.rows}`

  const panelRef = useRef<HTMLDivElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<Element | null>(document.activeElement)

  // Caller-supplied callbacks are read through refs so the listener effect
  // below (mount-only) always calls the latest ones without re-running (and
  // re-focusing) on every parent re-render.
  const onCancelRef = useRef(onCancel)
  const onConfirmRef = useRef(onConfirm)
  useEffect(() => {
    onCancelRef.current = onCancel
    onConfirmRef.current = onConfirm
  })

  // Mount-only: return focus to whatever triggered the dialog exactly once,
  // on unmount (AC10).
  useEffect(() => {
    const opener = openerRef.current
    return () => {
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [])

  useEffect(() => {
    cancelButtonRef.current?.focus()

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancelRef.current()
        return
      }
      if (event.key !== "Tab") return

      const first = cancelButtonRef.current
      const last = confirmButtonRef.current?.disabled ? cancelButtonRef.current : confirmButtonRef.current
      if (!first || !last) return

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    function handleFocusIn(event: FocusEvent) {
      const panel = panelRef.current
      if (panel && event.target instanceof Node && !panel.contains(event.target)) {
        cancelButtonRef.current?.focus()
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    document.addEventListener("focusin", handleFocusIn)
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      document.removeEventListener("focusin", handleFocusIn)
    }
  }, [])

  return (
    <div
      className="grid-change-confirmation__backdrop"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Save layout changes?"
    >
      <div ref={panelRef} className="grid-change-confirmation__panel" onClick={(event) => event.stopPropagation()}>
        <p className="grid-change-confirmation__message">
          The grid will change from <span data-testid="current-grid">{currentGridLabel}</span> to{" "}
          <span data-testid="target-grid">{targetGridLabel}</span>. The system will resize or reposition{" "}
          <span data-testid="affected-widget-count">{affectedWidgetIds.length}</span> existing widget
          {affectedWidgetIds.length === 1 ? "" : "s"}. Review before continuing.
        </p>
        <div className="grid-change-confirmation__actions">
          <Button ref={cancelButtonRef} onClick={onCancel}>
            Cancel
          </Button>
          <Button ref={confirmButtonRef} type="primary" onClick={onConfirm} disabled={disabled}>
            Continue and Save
          </Button>
        </div>
      </div>
    </div>
  )
}
