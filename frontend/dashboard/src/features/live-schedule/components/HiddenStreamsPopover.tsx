import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { useUpcomingDisplayMode } from "../../live-status/hooks/useUpcomingDisplayMode"
import { useTimeFormat } from "../../../shared/i18n/hooks/useTimeFormat"
import { t, type Locale } from "../../../shared/i18n/translations"
import { useMinuteClock } from "../../../shared/time/minuteClock"
import { streamStartText } from "../model/streamStartText"
import type { ScheduledStream } from "../model/scheduledStream"
import { getScheduleCreatorAvatarVisual } from "../utils/creatorAvatar"

const creatorsById = new Map(mockCreators.map((creator) => [creator.channelId, creator]))

/** Keeps the popover open for a moment after the pointer leaves, so crossing the small gap between the "+N" trigger and the panel never
 * closes it. */
const CLOSE_DELAY_MS = 160
const PANEL_WIDTH = 340
const VIEWPORT_MARGIN = 8
const TRIGGER_GAP = 6

function fallbackThumbnailUrl(videoId: string): string {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
}

/** One hidden stream: avatar, creator, title, time/status and thumbnail, all inside ONE button so a click anywhere on the row (or its
 * thumbnail) opens that exact stream's existing Schedule preview -- there is no nested clickable. */
function HiddenStreamRow({ stream, locale, now, onOpen }: { stream: ScheduledStream; locale: Locale; now: Date; onOpen: (stream: ScheduledStream) => void }) {
  const [displayMode] = useUpcomingDisplayMode()
  const [timeFormat] = useTimeFormat()
  const [thumbFailed, setThumbFailed] = useState(false)
  const creator = creatorsById.get(stream.channelId)
  const name = creator?.channelName ?? stream.channelId
  const visual = getScheduleCreatorAvatarVisual(stream.channelId, name)
  const startText = streamStartText(stream, locale, now.getTime(), displayMode, timeFormat)

  return (
    <button type="button" className="hidden-streams-popover__item" data-video-id={stream.videoId} onClick={() => onOpen(stream)}>
      <span className="creator-avatar-circle hidden-streams-popover__avatar" style={visual.avatarUrl ? undefined : { background: visual.background, color: visual.color }}>
        {visual.avatarUrl ? <img src={visual.avatarUrl} alt="" /> : visual.initial}
      </span>
      <span className="hidden-streams-popover__text">
        <span className="hidden-streams-popover__creator">{name}</span>
        <span className="hidden-streams-popover__title">{stream.title}</span>
        <span className="hidden-streams-popover__time">
          {stream.status === "live" && <span className="hidden-streams-popover__live">{t(locale, "liveSchedule.liveBadge")}</span>}
          {startText}
        </span>
      </span>
      <span className="hidden-streams-popover__thumb">
        {thumbFailed ? (
          <span className="hidden-streams-popover__thumb-placeholder">{t(locale, "liveSchedule.noThumbnail")}</span>
        ) : (
          <img src={stream.thumbnailUrl || fallbackThumbnailUrl(stream.videoId)} alt="" draggable={false} onError={() => setThumbFailed(true)} />
        )}
      </span>
    </button>
  )
}

/** The "+N" control of a Schedule slot that has more streams than it can show as avatars. `streams` are exactly the HIDDEN ones (the visible
 * avatars are never repeated), so N is the real number of hidden streams. The trigger itself never opens a stream: hovering or focusing it
 * (or clicking, for touch) opens a floating panel listing every hidden stream, and each row opens that exact stream's existing preview.
 * The panel stays open while the pointer moves from the trigger into it; Escape, an outside click, or leaving both closes it. */
export function HiddenStreamsPopover({ streams, locale, onSelectStream }: { streams: ScheduledStream[]; locale: Locale; onSelectStream: (stream: ScheduledStream) => void }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | null>(null)
  // Escape hands focus back to the trigger; that programmatic focus must not reopen the list it just closed.
  const skipNextFocusOpen = useRef(false)
  const panelId = useId()
  const now = useMinuteClock()

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])
  const show = useCallback(() => {
    cancelClose()
    setOpen(true)
  }, [cancelClose])
  const scheduleClose = useCallback(() => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
  }, [cancelClose])
  const closeNow = useCallback(() => {
    cancelClose()
    setOpen(false)
  }, [cancelClose])

  useEffect(() => cancelClose, [cancelClose])

  // Position next to the trigger, kept inside the viewport (below it, or above when there is no room below).
  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const panel = panelRef.current
    if (!trigger || !panel) return
    const rect = trigger.getBoundingClientRect()
    const width = Math.min(PANEL_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2)
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - VIEWPORT_MARGIN))
    const height = panel.offsetHeight
    const below = rect.bottom + TRIGGER_GAP
    const top = below + height <= window.innerHeight - VIEWPORT_MARGIN ? below : Math.max(VIEWPORT_MARGIN, rect.top - TRIGGER_GAP - height)
    setPosition({ top, left })
  }, [open, streams.length])

  // Escape and an outside click close it.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      closeNow()
      skipNextFocusOpen.current = true
      triggerRef.current?.focus()
      // (A trigger that already had focus fires no focus event, so the flag must not outlive this tick.)
      window.setTimeout(() => {
        skipNextFocusOpen.current = false
      }, 0)
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      closeNow()
    }
    document.addEventListener("keydown", onKeyDown)
    document.addEventListener("pointerdown", onPointerDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("pointerdown", onPointerDown)
    }
  }, [open, closeNow])

  const openStream = (stream: ScheduledStream) => {
    closeNow()
    onSelectStream(stream)
  }

  const focusLeftBoth = (event: React.FocusEvent) => {
    const next = event.relatedTarget as Node | null
    if (next && (panelRef.current?.contains(next) || triggerRef.current?.contains(next))) return
    scheduleClose()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="more-streams"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={t(locale, "liveSchedule.moreStreamsAria", { count: String(streams.length) })}
        onPointerEnter={show}
        onPointerLeave={scheduleClose}
        onFocus={() => {
          if (skipNextFocusOpen.current) return
          show()
        }}
        onBlur={focusLeftBoth}
        onClick={(event) => {
          // A click only makes sure the list is showing (touch / keyboard; with a mouse it is already open from the hover) -- it never opens a
          // stream itself, and never closes the list (Escape, an outside click or leaving it do).
          show()
          if (event.detail === 0) requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>("button")?.focus())
        }}
      >
        +{streams.length}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-label={t(locale, "liveSchedule.moreStreamsAria", { count: String(streams.length) })}
            className="hidden-streams-popover"
            style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? "visible" : "hidden" }}
            onPointerEnter={cancelClose}
            onPointerLeave={scheduleClose}
            onBlur={focusLeftBoth}
          >
            {streams.map((stream) => (
              <HiddenStreamRow key={stream.id} stream={stream} locale={locale} now={now} onOpen={openStream} />
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
