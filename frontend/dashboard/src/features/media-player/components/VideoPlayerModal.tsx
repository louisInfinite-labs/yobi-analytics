import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { X } from "lucide-react"
import { useWatchedDuringLive } from "../hooks/useWatchedDuringLive"
import { currentFullscreenElement, enterFullscreenPlayback, isTouchDevice, leaveFullscreenPlayback, unlockOrientation } from "../utils/fullscreenPlayback"
import { useBodyScrollLock } from "../../../shared/hooks/useBodyScrollLock"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"

/** How long the "rotate your device" hint stays up before it fades on its own. */
const ROTATE_HINT_MS = 6000

interface VideoPlayerModalProps {
  videoId: string
  title: string
  onClose: () => void
  /** "player-only" renders just the 16:9 player (no close button, no visible
   * title, no card padding); backdrop click and Escape still close it. */
  variant?: "standard" | "player-only"
  /** Whether this videoId is a livestream that is live right now. Passing a boolean (even false) makes the embed
   * report playback through the YouTube IFrame API so a confirmed PLAYING while live is recorded as "watched during
   * live" (see useWatchedDuringLive); leaving it undefined keeps the plain embed with no tracking at all. */
  isLive?: boolean
  /** The player was opened by a direct tap and should ask for fullscreen (then a landscape lock) FROM THAT SAME TAP -- the request is made while
   * this mounts, so the caller must mount it synchronously inside the tap (flushSync). Only a touch device is ever sent fullscreen; a desktop
   * keeps this exact modal. If fullscreen or the lock is unavailable, refused or blocked by the OS, the normal responsive player plays on. */
  fullscreenOnOpen?: boolean
}

/** Centered, medium-sized YouTube player over a dimmed backdrop. Closes on
 * a backdrop click, the close button, or Escape — never on a click inside
 * the player itself. Traps Tab/Shift+Tab between the close button and the
 * iframe (the panel's only two focusable elements) and restores focus to
 * whatever opened it on close, so keyboard users never land on background
 * controls while the modal is open. In the "player-only" variant there is no
 * close button, so the panel itself is the first focus stop. */
export function VideoPlayerModal({ videoId, title, onClose, variant = "standard", isLive, fullscreenOnOpen = false }: VideoPlayerModalProps) {
  const playerOnly = variant === "player-only"
  const [locale] = useLocale()
  const [showRotateHint, setShowRotateHint] = useState(false)
  const touchFullscreen = fullscreenOnOpen && isTouchDevice()
  useBodyScrollLock(touchFullscreen)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const openerRef = useRef<Element | null>(document.activeElement)
  useWatchedDuringLive(iframeRef, videoId, isLive)
  const embedParams = isLive === undefined ? "autoplay=1" : `autoplay=1&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`

  // Fullscreen + landscape, best effort. A layout effect on purpose: with the caller's flushSync it runs inside the opening tap, which is the
  // only moment the browser will grant fullscreen (a passive effect or a timer could land after the activation is gone). Once it has
  // succeeded the landscape lock is attempted; when it cannot be had on a portrait screen a small non-blocking hint asks for a rotation
  // instead. Leaving fullscreen by any route (the OS back gesture, Escape) unlocks the orientation and keeps the responsive player playing;
  // closing the player does both and leaves fullscreen.
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!touchFullscreen || !panel) return
    let cancelled = false
    void enterFullscreenPlayback(panel).then((outcome) => {
      if (cancelled || outcome.orientationLocked) return
      if (window.matchMedia("(orientation: portrait)").matches) setShowRotateHint(true)
    })
    // Only when NOTHING is fullscreen any more: the player handing fullscreen to its own YouTube iframe (their fullscreen button) is not an exit.
    function handleFullscreenChange() {
      if (!currentFullscreenElement()) unlockOrientation()
    }
    document.addEventListener("fullscreenchange", handleFullscreenChange)
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange)
    return () => {
      cancelled = true
      document.removeEventListener("fullscreenchange", handleFullscreenChange)
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange)
      leaveFullscreenPlayback(panel)
    }
  }, [touchFullscreen])

  // The hint is a courtesy: it fades on its own, and goes the moment the device is turned to landscape.
  useEffect(() => {
    if (!showRotateHint) return
    const landscape = window.matchMedia("(orientation: landscape)")
    const hide = () => setShowRotateHint(false)
    const timer = window.setTimeout(hide, ROTATE_HINT_MS)
    landscape.addEventListener("change", hide)
    return () => {
      window.clearTimeout(timer)
      landscape.removeEventListener("change", hide)
    }
  }, [showRotateHint])

  useEffect(() => {
    const firstStop = () => (playerOnly ? panelRef.current : closeButtonRef.current)
    firstStop()?.focus()
    const opener = openerRef.current

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose()
        return
      }
      if (event.key !== "Tab") return

      const first = firstStop()
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
        firstStop()?.focus()
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    document.addEventListener("focusin", handleFocusIn)
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      document.removeEventListener("focusin", handleFocusIn)
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [onClose, playerOnly])

  return (
    <div
      className="video-player-modal__backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Playing ${title}`}
    >
      <div
        ref={panelRef}
        className={`video-player-modal__panel${playerOnly ? " video-player-modal__panel--player-only" : ""}`}
        tabIndex={playerOnly ? -1 : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {!playerOnly && (
          <button type="button" ref={closeButtonRef} className="video-player-modal__close" onClick={onClose} aria-label="Close video player">
            <X size={18} aria-hidden="true" />
          </button>
        )}
        <div className="video-player-modal__frame">
          <iframe
            ref={iframeRef}
            src={`https://www.youtube.com/embed/${videoId}?${embedParams}`}
            title={title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
        {showRotateHint && (
          <div className="video-player-modal__hint" role="status">
            {t(locale, "videoPlayer.rotateHint")}
          </div>
        )}
        {!playerOnly && <p className="video-player-modal__title">{title}</p>}
      </div>
    </div>
  )
}
