import { useEffect, useRef } from "react"
import { X } from "lucide-react"

interface VideoPlayerModalProps {
  videoId: string
  title: string
  onClose: () => void
}

/** Centered, medium-sized YouTube player over a dimmed backdrop. Closes on
 * a backdrop click, the close button, or Escape — never on a click inside
 * the player itself. */
export function VideoPlayerModal({ videoId, title, onClose }: VideoPlayerModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeButtonRef.current?.focus()

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [onClose])

  return (
    <div
      className="video-player-modal__backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Playing ${title}`}
    >
      <div className="video-player-modal__panel" onClick={(e) => e.stopPropagation()}>
        <button type="button" ref={closeButtonRef} className="video-player-modal__close" onClick={onClose} aria-label="Close video player">
          <X size={18} aria-hidden="true" />
        </button>
        <div className="video-player-modal__frame">
          <iframe
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
