import { useEffect, useRef } from "react"
import { X } from "lucide-react"

interface VideoPlayerModalProps {
  videoId: string
  title: string
  onClose: () => void
}

/** Centered, medium-sized YouTube player over a dimmed backdrop. Closes on
 * a backdrop click, the close button, or Escape — never on a click inside
 * the player itself. Traps Tab/Shift+Tab between the close button and the
 * iframe (the panel's only two focusable elements) and restores focus to
 * whatever opened it on close, so keyboard users never land on background
 * controls while the modal is open. */
export function VideoPlayerModal({ videoId, title, onClose }: VideoPlayerModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const openerRef = useRef<Element | null>(document.activeElement)

  useEffect(() => {
    closeButtonRef.current?.focus()
    const opener = openerRef.current

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose()
        return
      }
      if (event.key !== "Tab") return

      const first = closeButtonRef.current
      const last = iframeRef.current
      if (!first || !last) return

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    // handleKeyDown alone can't trap focus once it's inside the YouTube
    // iframe — Tab events fired inside that cross-origin document never
    // reach this document's keydown listener at all, so the browser's own
    // tab order (unaware of the modal) can carry focus straight to a
    // background control behind it. This document-level focusin handler
    // catches that case instead: it can't see keystrokes inside the
    // iframe, but it does see the moment focus successfully lands on an
    // element outside the panel (in this same document), and pulls it back.
    function handleFocusIn(event: FocusEvent) {
      const panel = panelRef.current
      if (panel && event.target instanceof Node && !panel.contains(event.target)) {
        closeButtonRef.current?.focus()
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    document.addEventListener("focusin", handleFocusIn)
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      document.removeEventListener("focusin", handleFocusIn)
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [onClose])

  return (
    <div
      className="video-player-modal__backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Playing ${title}`}
    >
      <div ref={panelRef} className="video-player-modal__panel" onClick={(e) => e.stopPropagation()}>
        <button type="button" ref={closeButtonRef} className="video-player-modal__close" onClick={onClose} aria-label="Close video player">
          <X size={18} aria-hidden="true" />
        </button>
        <div className="video-player-modal__frame">
          <iframe
            ref={iframeRef}
            src={`https://www.youtube.com/embed/${videoId}?autoplay=1`}
            title={title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
        <p className="video-player-modal__title">{title}</p>
      </div>
    </div>
  )
}
