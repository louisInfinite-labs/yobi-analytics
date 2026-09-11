import { useEffect, useRef, useState } from "react"
import { t, type Locale } from "../i18n/translations"

interface OshiSwitchConfirmDialogProps {
  creatorName: string
  locale: Locale
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}

/** Confirms an Oshi switch before it happens (spec section 5/6/7). Structure
 * is exactly message / checkbox / Cancel+Switch — no title, subtitle, or
 * icon, since no such elements exist in any project confirm dialog to match.
 * Backdrop click, Esc, and Tab-trapping follow the same convention already
 * established by VideoPlayerModal. Checking "Don't ask again" only takes
 * effect together with Switch — Cancel never persists it (spec section 7). */
export function OshiSwitchConfirmDialog({ creatorName, locale, onCancel, onConfirm }: OshiSwitchConfirmDialogProps) {
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const checkboxRef = useRef<HTMLInputElement>(null)
  const switchButtonRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<Element | null>(document.activeElement)

  useEffect(() => {
    checkboxRef.current?.focus()
    const opener = openerRef.current

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel()
        return
      }
      if (event.key !== "Tab") return

      const first = checkboxRef.current
      const last = switchButtonRef.current
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
        checkboxRef.current?.focus()
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    document.addEventListener("focusin", handleFocusIn)
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      document.removeEventListener("focusin", handleFocusIn)
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [onCancel])

  const message = t(locale, "oshiSwitch.confirmMessage", { creatorName })

  return (
    <div className="oshi-switch-confirm__backdrop" onClick={onCancel} role="dialog" aria-modal="true" aria-label={message}>
      <div ref={panelRef} className="oshi-switch-confirm__panel" onClick={(event) => event.stopPropagation()}>
        <p className="oshi-switch-confirm__message">{message}</p>
        <label className="oshi-switch-confirm__checkbox-row">
          <input
            ref={checkboxRef}
            type="checkbox"
            checked={dontAskAgain}
            onChange={(event) => setDontAskAgain(event.target.checked)}
          />
          {t(locale, "oshiSwitch.dontAskAgain")}
        </label>
        <div className="oshi-switch-confirm__actions">
          <button type="button" className="oshi-switch-confirm__cancel" onClick={onCancel}>
            {t(locale, "common.cancel")}
          </button>
          <button
            type="button"
            ref={switchButtonRef}
            className="oshi-switch-confirm__confirm"
            onClick={() => onConfirm(dontAskAgain)}
          >
            {t(locale, "oshiSwitch.confirmAction")}
          </button>
        </div>
      </div>
    </div>
  )
}
