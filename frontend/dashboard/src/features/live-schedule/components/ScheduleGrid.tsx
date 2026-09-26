import { useLayoutEffect, useRef } from "react"
import { getCreatorAvatarVisual } from "../../analytics/charts/CreatorAvatar"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { SLOT_COUNT, initialScrollSlotIndex, slotLabel } from "../model/scheduleGrid"
import type { ScheduleDay } from "../hooks/useWeeklySchedule"
import type { ScheduledStream } from "../model/scheduledStream"
import { t, type Locale } from "../../../shared/i18n/translations"

const creatorsById = new Map(mockCreators.map((creator) => [creator.channelId, creator]))

// Spec: up to 3 avatars shown once a slot has more than 4 streams, with a
// "+N" pill for the rest -- 4 or fewer streams in one slot show every avatar.
const MAX_AVATARS_BEFORE_OVERFLOW = 4
const VISIBLE_AVATARS_WHEN_OVERFLOWING = 3

interface ScheduleGridProps {
  locale: Locale
  days: ScheduleDay[]
  now: Date
  selectedStreamId: string | null
  onSelectStream: (stream: ScheduledStream) => void
}

function StreamAvatarGroup({ streams, locale, onSelectStream }: { streams: ScheduledStream[]; locale: Locale; onSelectStream: (stream: ScheduledStream) => void }) {
  const visibleCount = streams.length > MAX_AVATARS_BEFORE_OVERFLOW ? VISIBLE_AVATARS_WHEN_OVERFLOWING : streams.length
  const visibleStreams = streams.slice(0, visibleCount)
  const hiddenStreams = streams.slice(visibleCount)

  return (
    <div className="stream-avatar-group">
      {visibleStreams.map((stream) => {
        const creator = creatorsById.get(stream.channelId)
        const visual = getCreatorAvatarVisual(stream.channelId, creator?.channelName ?? stream.channelId)
        return (
          <div key={stream.id} className="stream-avatar-item">
            {stream.status === "live" && <span className="stream-avatar-live-badge">{t(locale, "liveSchedule.liveBadge")}</span>}
            <button type="button" className="stream-avatar-button" onClick={() => onSelectStream(stream)} aria-label={stream.title}>
              <span className="stream-avatar" style={visual.avatarUrl ? undefined : { background: visual.background, color: visual.color }}>
                {visual.avatarUrl ? <img src={visual.avatarUrl} alt="" /> : visual.initial}
              </span>
            </button>
          </div>
        )
      })}
      {hiddenStreams.length > 0 && (
        // Opens the first hidden stream -- there's no overflow-list/popover
        // in the approved spec, so this is the simplest control that still
        // makes every stream in the slot reachable rather than only the
        // first 3.
        <button
          type="button"
          className="more-streams"
          onClick={() => onSelectStream(hiddenStreams[0])}
          aria-label={t(locale, "liveSchedule.moreStreamsAria", { count: String(hiddenStreams.length) })}
        >
          +{hiddenStreams.length}
        </button>
      )}
    </div>
  )
}

export function ScheduleGrid({ locale, days, now, selectedStreamId, onSelectStream }: ScheduleGridProps) {
  const gridRef = useRef<HTMLDivElement>(null)
  const hasScrolledRef = useRef(false)

  // Once on mount only -- later `days`/`now` refreshes must never move a
  // viewport the user may already be scrolling by hand.
  useLayoutEffect(() => {
    if (hasScrolledRef.current) return
    hasScrolledRef.current = true
    const grid = gridRef.current
    if (!grid) return
    const slotIndex = initialScrollSlotIndex(days, now)
    const row = grid.querySelector(".time-body")?.children[slotIndex]
    if (!row) return
    const headerHeight = grid.querySelector<HTMLElement>(".schedule-day-header")?.offsetHeight ?? 0
    grid.scrollTop += row.getBoundingClientRect().top - grid.getBoundingClientRect().top - headerHeight
  }, [days, now])

  return (
    <section className="schedule-grid-shell">
      <div className="schedule-grid" ref={gridRef}>
        <div className="time-column">
          <div className="time-header">{t(locale, "liveSchedule.timeColumnHeader")}</div>
          <div className="time-body">
            {Array.from({ length: SLOT_COUNT }, (_, slotIndex) => {
              const { hour, minute } = slotLabel(slotIndex)
              return (
                <div key={slotIndex} className="time-label" data-minute={minute}>
                  {minute === "00" ? `${hour}:00` : ""}
                </div>
              )
            })}
          </div>
        </div>

        {days.map((day) => (
          <div className="day-column" key={day.date.toISOString()}>
            <div className={`schedule-day-header${day.isToday ? " is-today" : ""}`}>
              <span className="day-name">{day.date.toLocaleDateString(locale, { weekday: "short" })}</span>
              <span className="day-date">{day.date.toLocaleDateString(locale, { month: "numeric", day: "numeric" })}</span>
            </div>

            <div className={`day-timeline${day.isToday ? " is-today" : ""}`}>
              {day.slots.map((streams, slotIndex) => {
                const hasSelectedStream = streams.some((stream) => stream.id === selectedStreamId)
                return (
                  <div key={slotIndex} className={`schedule-slot${hasSelectedStream ? " has-selected-stream" : ""}`}>
                    {streams.length > 0 && <StreamAvatarGroup streams={streams} locale={locale} onSelectStream={onSelectStream} />}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
