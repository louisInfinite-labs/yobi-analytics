import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { HiddenStreamsPopover } from "./HiddenStreamsPopover"
import { ScheduleDayNavigator } from "./ScheduleDayNavigator"
import { ScheduleResultsDrawer } from "./ScheduleResultsDrawer"
import { getScheduleCreatorAvatarVisual } from "../utils/creatorAvatar"
import { getScheduleCreatorName } from "../utils/scheduleCreatorName"
import { DEFAULT_AVATAR_SIZE_PX, visibleAvatarCount } from "../model/scheduleAvatarOverflow"
import { SLOT_COUNT, dayKey, initialScrollSlotIndex, resolveSelectedDayIndex, slotLabel } from "../model/scheduleGrid"
import { buildScheduleResults, occupiedSlotIndexes } from "../model/scheduleResults"
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
  /** A Creator Filter is applied: the multi-day grid collapses the rows no displayed day has an event in, and the phone layout adds its results drawer. */
  creatorFilterActive?: boolean
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
            {stream.status === "premiere" && <span className="stream-avatar-premiere-badge">{t(locale, "liveSchedule.premiereBadge")}</span>}
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

/** Brings grid row `slotIndex` to just below what stays pinned above the rows: the multi-day grid's day-name header; on a phone the date
 * navigator (and the app top bar above it). Moves the document, not the grid -- Schedule uses normal page scrolling. */
function scrollSlotRowToTop(grid: HTMLElement, slotIndex: number) {
  const row = grid.querySelector(`.time-body > [data-slot="${slotIndex}"]`)
  if (!row) return
  const pinned = grid.querySelector<HTMLElement>(".schedule-day-header")?.offsetHeight ?? 0
  const dayNav = grid.closest(".schedule-grid-shell")?.querySelector<HTMLElement>(".schedule-day-nav")
  const topBar = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--main-topbar-height")) || 0
  const headerHeight = pinned + (dayNav ? dayNav.offsetHeight + topBar : 0)
  const rowTop = row.getBoundingClientRect().top + window.scrollY
  window.scrollTo(0, rowTop - headerHeight)
}

/** The Schedule timetable: the multi-day grid, or on a phone one day at a time with the results drawer while a Creator Filter is applied. */
export function ScheduleGrid({ locale, days, now, selectedStreamId, onSelectStream, holdPreviousDay = false, creatorFilterActive = false }: ScheduleGridProps) {
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

  // With a Creator Filter applied the multi-day grid drops every row that none of the seven days has an event in. The rows kept are ONE list
  // shared by the time labels and every day column, so the columns stay aligned. A filter that matches nothing replaces the grid with a compact
  // empty state instead of 48 empty rows. The phone keeps its full one-day layout either way (its drawer carries the empty message).
  const occupiedRows = useMemo(() => occupiedSlotIndexes(days), [days])
  const showEmptyState = !phone && creatorFilterActive && occupiedRows.length === 0

  // The width one slot really has, so the "+N" collapse follows the layout (resize, rotation, another day) instead of a fixed count.
  // Every day column is as wide as the others, so the first one is measured.
  const [availableWidth, setAvailableWidth] = useState<number | null>(null)
  const [avatarSize, setAvatarSize] = useState(DEFAULT_AVATAR_SIZE_PX)
  const measureKey = `${phone ? "phone" : "multi"}:${shownDays.length}:${shownDays[0] ? dayKey(shownDays[0].date) : ""}:${showEmptyState ? "empty" : "grid"}`
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

  const collapseRows = !phone && creatorFilterActive && occupiedRows.length > 0
  const rowIndexes = useMemo(() => (collapseRows ? occupiedRows : Array.from({ length: SLOT_COUNT }, (_, slotIndex) => slotIndex)), [collapseRows, occupiedRows])

  const resultGroups = useMemo(() => buildScheduleResults(days), [days])
  const showResultsDrawer = phone && creatorFilterActive

  // A result row asked for a slot. The scroll runs after the commit that switched the day and collapsed the drawer -- the collapsed layout (shorter
  // page, its own bottom room) is what the target position must be computed against, and a new object per request makes choosing the same slot twice
  // still scroll. The time rows are the same on every day, so the row to scroll to is already in the page.
  const [slotRequest, setSlotRequest] = useState<{ slotIndex: number } | null>(null)
  useLayoutEffect(() => {
    if (!slotRequest || !gridRef.current) return
    scrollSlotRowToTop(gridRef.current, slotRequest.slotIndex)
  }, [slotRequest])

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
    scrollSlotRowToTop(grid, initialScrollSlotIndex(days, now))
  }, [days, now])

  return (
    <section className="schedule-grid-shell">
      {phone && <ScheduleDayNavigator locale={locale} days={days} selectedIndex={selectedIndex} onSelectIndex={selectIndex} />}
      {showEmptyState ? (
        <div className="schedule-grid-empty" role="status">
          {t(locale, "liveSchedule.resultsEmpty")}
        </div>
      ) : (
        <div className="schedule-grid" ref={gridRef} {...swipe}>
          <div className="time-column">
            <div className="time-header">{t(locale, "liveSchedule.timeColumnHeader")}</div>
            <div className="time-body">
              {rowIndexes.map((slotIndex) => {
                const { hour, minute } = slotLabel(slotIndex)
                // Collapsed rows are not a regular half-hour ladder, so each kept row names its own time (a kept :30 row has no :00 row above it).
                return (
                  <div key={slotIndex} className="time-label" data-minute={minute} data-slot={slotIndex}>
                    {minute === "00" || collapseRows ? formatClockTime(new Date(2000, 0, 1, Number(hour), Number(minute)), timeFormat) : ""}
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
                {rowIndexes.map((slotIndex) => {
                  const streams = day.slots[slotIndex]
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
      )}

      {showResultsDrawer && (
        <ScheduleResultsDrawer
          locale={locale}
          groups={resultGroups}
          onSelectResult={(group, item) => {
            // Change the day and ask for the slot; the scroll itself waits for the commit (the drawer collapses in the same update), see below.
            setSelectedKey(group.dayKey)
            setSlotRequest({ slotIndex: item.slotIndex })
          }}
          onSelectStream={onSelectStream}
        />
      )}
    </section>
  )
}
