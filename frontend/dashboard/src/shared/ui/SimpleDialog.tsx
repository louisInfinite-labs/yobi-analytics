import { useId, useRef, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useModalFocus } from "../hooks/useModalFocus"
import "../styles/simpleDialog.css"

interface SimpleDialogProps {
  title: string
  /** Backdrop click and Escape both call this. */
  onClose: () => void
  children: ReactNode
  /** The action buttons (right-aligned, wrapping on narrow screens). */
  actions: ReactNode
}

/** A small modal for short messages with a title, body and a few actions -- the same convention as VideoPlayerModal /
 * OshiSwitchConfirmDialog (backdrop click and Esc close it, Tab stays inside, focus returns to the opener), through the shared
 * useModalFocus. Portalled to <body> so it is never clipped or re-anchored by a transformed ancestor (e.g. a Drawer). */
export function SimpleDialog({ title, onClose, children, actions }: SimpleDialogProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  useModalFocus(panelRef, onClose)

  return createPortal(
    <div className="simple-dialog__backdrop" onClick={onClose}>
      <div ref={panelRef} className="simple-dialog__panel" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <h2 id={titleId} className="simple-dialog__title">
          {title}
        </h2>
        <div className="simple-dialog__body">{children}</div>
        <div className="simple-dialog__actions">{actions}</div>
      </div>
    </div>,
    document.body,
  )
}
