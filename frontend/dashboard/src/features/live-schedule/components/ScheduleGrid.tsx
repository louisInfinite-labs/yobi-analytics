import { useLayoutEffect, useRef, useState } from "react"
import { HiddenStreamsPopover } from "./HiddenStreamsPopover"
import { ScheduleDayNavigator } from "./ScheduleDayNavigator"
import { getScheduleCreatorAvatarVisual } from "../utils/creatorAvatar"
import { getScheduleCreatorName } from "../utils/scheduleCreatorName"
import { DEFAULT_AVATAR_SIZE_PX, visibleAvatarCount } from "../model/scheduleAvatarOverflow"
import { SLOT_COUNT, dayKey, initialScrollSlotIndex, resolveSelectedDayIndex, slotLabel } from "../model/scheduleGrid"
import type { ScheduleDay } from "../hooks/useWeeklySchedule"
import type { ScheduledStream } from "../model/scheduledStream"
import { t, type Locale } from "../../../shared/i18n/translations"
import { useTimeFormat } from "../../../shared/i18n/hooks/useTimeFormat"
import { formatClockTime } from "../../../shared/i18n/model/timeFormat"
import { useBreakpoint } from "../../../shared/hooks/useBreakpoint"
import { useDaySwipe } from "../hooks/useDaySwipe"

interface ScheduleGridProps {
  locale: Locale
  days: ScheduleDay[]
  now: Date
  selectedStreamId: string | null
  onSelectStream: (stream: ScheduledStream) => void
  /** The window starts before today (an overnight stream is unresolved): the single-day phone layout opens on its first day, not today. */
  holdPreviousDay?: boolean
}

interface AvatarCapacity {
  /** The width one slot's avatar group may use, or null when it has not been measured (then only the fixed multi-day rule applies). */
  availableWidth: number | null
  avatarSize: number
  /** The multi-day grid keeps its fixed "more than 4 -> 3 + +N" rule as an upper bound; the single-day phone layout is bounded by width only. */
  boundedByFixedRule: boolean
}

function StreamAvatarGroup({
  streams,
  locale,
  onSelectStream,
  capacity,
}: {
  streams: ScheduledStream[]
  locale: Locale
  onSelectStream: (stream: ScheduledStream) => void
  capacity: AvatarCapacity
}) {
  const visibleCount = visibleAvatarCount(streams.length, capacity)
  const visibleStreams = streams.slice(0, visibleCount)
  const hiddenStreams = streams.slice(visibleCount)

  return (
    <div className="stream-avatar-group">
      {visibleStreams.map((stream) => {
        const visual = getScheduleCreatorAvatarVisual(stream.channelId, getScheduleCreatorName(stream.channelId))
        return (
          <div key={stream.id} className="stream-avatar-item">
            {stream.status === "live" && <span className="stream-avatar-live-badge">{t(locale, "liveSchedule.liveBadge")}</span>}
            <button type="button" className="stream-avatar-button" onClick={() => onSelectStream(stream)} aria-label={stream.title}>
              <span className="creator-avatar-circle stream-avatar" style={visual.avatarUrl ? undefined : { background: visual.background, color: visual.color }}>
                {visual.avatarUrl ? <img src={visual.avatarUrl} alt="" /> : visual.initial}
              </span>
            </button>
          </div>
        )
      })}
      {hiddenStreams.length > 0 && <HiddenStreamsPopover streams={hiddenStreams} locale={locale} onSelectStream={onSelectStream} />}
    </div>
  )
}

export function ScheduleGrid({ locale, days, now, selectedStreamId, onSelectStream, holdPreviousDay = false }: ScheduleGridProps) {
  const gridRef = useRef<HTMLDivElement>(null)
  const hasScrolledRef = useRef(false)
  const [timeFormat] = useTimeFormat()

  // Phone (below 768px): ONE day at a time, chosen from the days already loaded -- never several squeezed columns, never another request.
  // Tablet and desktop keep the multi-day grid. The selection is the day's date (not an index), so it survives the day window rolling over.
  const phone = useBreakpoint() === "mobile"
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const selectedIndex = selectedKey === null && holdPreviousDay ? 0 : resolveSelectedDayIndex(days, selectedKey)
  const shownDays = phone && days[selectedIndex] ? [days[selectedIndex]] : days
  // The same move the < and > buttons make, driven by a horizontal swipe (the single-day layout is the only one with a selected day). Never
  // wraps: the first and last day simply stop. The selection is stored as the day's date key either way.
  const selectIndex = (index: number) => setSelectedKey(dayKey(days[index].date))
  const swipe = useDaySwipe({
    enabled: phone && days.length > 1,
    canPrevious: selectedIndex > 0,
    canNext: selectedIndex < days.length - 1,
    onPrevious: () => selectIndex(selectedIndex - 1),
    onNext: () => selectIndex(selectedIndex + 1),
  })

  // The width one slot really has, so the "+N" collapse follows the layout (resize, rotation, another day) instead of a fixed count.
  // Every day column is as wide as the others, so the first one is measured.
  const [availableWidth, setAvailableWidth] = useState<number | null>(null)
  const [avatarSize, setAvatarSize] = useState(DEFAULT_AVATAR_SIZE_PX)
  const measureKey = `${phone ? "phone" : "multi"}:${shownDays.length}:${shownDays[0] ? dayKey(shownDays[0].date) : ""}`
  useLayoutEffect(() => {
    const column = gridRef.current?.querySelector<HTMLElement>(".day-timeline")
    if (!column) return
    const measure = () => {
      const width = column.clientWidth
      setAvailableWidth(width > 0 ? width : null) // 0 = no layout (e.g. a test renderer): unknown, not "nothing fits"
      const size = Number.parseFloat(getComputedStyle(column).getPropertyValue("--creator-avatar-size"))
      if (Number.isFinite(size) && size > 0) setAvatarSize(size)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(column)
    return () => observer.disconnect()
  }, [measureKey])
  const capacity: AvatarCapacity = { availableWidth, avatarSize, boundedByFixedRule: !phone }

  // Once on mount only -- later `days`/`now` refreshes must never move a
  // viewport the user may already be scrolling by hand. Scrolls the
  // document (window.scrollTo), not the grid itself: the grid no longer
  // owns its own scroll (Schedule uses normal page scrolling; see
  // schedule.css's own comment on .schedule-page).
  useLayoutEffect(() => {
    if (hasScrolledRef.current) return
    hasScrolledRef.current = true
    const grid = gridRef.current
    if (!grid) return
    const slotIndex = initialScrollSlotIndex(days, now)
    const row = grid.querySelector(".time-body")?.children[slotIndex]
    if (!row) return
    // What stays pinned above the rows: the multi-day grid's day-name header; on a phone the date navigator (and the app top bar above it).
    const pinned = grid.querySelector<HTMLElement>(".schedule-day-header")?.offsetHeight ?? 0
    const dayNav = grid.closest(".schedule-grid-shell")?.querySelector<HTMLElement>(".schedule-day-nav")
    const topBar = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--main-topbar-height")) || 0
    const headerHeight = pinned + (dayNav ? dayNav.offsetHeight + topBar : 0)
    const rowTop = row.getBoundingClientRect().top + window.scrollY
    window.scrollTo(0, rowTop - headerHeight)
  }, [days, now])

  return (
    <section className="schedule-grid-shell">
      {phone && <ScheduleDayNavigator locale={locale} days={days} selectedIndex={selectedIndex} onSelectIndex={selectIndex} />}
      <div className="schedule-grid" ref={gridRef} {...swipe}>
        <div className="time-column">
          <div className="time-header">{t(locale, "liveSchedule.timeColumnHeader")}</div>
          <div className="time-body">
            {Array.from({ length: SLOT_COUNT }, (_, slotIndex) => {
              const { hour, minute } = slotLabel(slotIndex)
              return (
                <div key={slotIndex} className="time-label" data-minute={minute}>
                  {minute === "00" ? formatClockTime(new Date(2000, 0, 1, Number(hour), 0), timeFormat) : ""}
                </div>
              )
            })}
          </div>
        </div>

        {shownDays.map((day) => (
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
                    {streams.length > 0 && <StreamAvatarGroup streams={streams} locale={locale} onSelectStream={onSelectStream} capacity={capacity} />}
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
