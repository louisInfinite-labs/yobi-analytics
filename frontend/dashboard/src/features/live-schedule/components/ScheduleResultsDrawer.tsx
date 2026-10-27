import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"
import { getScheduleCreatorAvatarVisual } from "../utils/creatorAvatar"
import { getScheduleCreatorName } from "../utils/scheduleCreatorName"
import type { ScheduleResultGroup, ScheduleResultItem } from "../model/scheduleResults"
import type { ScheduledStream } from "../model/scheduledStream"
import { t, type Locale } from "../../../shared/i18n/translations"
import { useTimeFormat } from "../../../shared/i18n/hooks/useTimeFormat"
import { formatClockTime } from "../../../shared/i18n/model/timeFormat"

interface ScheduleResultsDrawerProps {
  locale: Locale
  groups: ScheduleResultGroup[]
  /** A result row was chosen: the grid moves to that date and time slot. */
  onSelectResult: (group: ScheduleResultGroup, item: ScheduleResultItem) => void
  /** A result's avatar was chosen: the existing livestream dialog opens for that stream. */
  onSelectStream: (stream: ScheduledStream) => void
}

/** The page-level custom property carrying the expanded drawer's real height, so the page reserves exactly that much room under the grid. */
const RESULTS_HEIGHT_VAR = "--schedule-results-height"

/** The phone Schedule's results drawer, shown while a Creator Filter is applied: a full-width bottom sheet listing every matching event
 * grouped by date, soonest first. Its height follows its content (header, date headings, rows, padding, safe-area inset) up to the CSS
 * max-height in schedule.css (85% of the visible viewport, always leaving room for the Schedule above); beyond that the list scrolls on its
 * own and the header stays put. The height is measured, then held: a background data refresh that only adds, drops or reorders events never
 * resizes the sheet under the user's finger (the list simply scrolls, or has a little spare room). It is measured again when the set of
 * creators in the results changes (a new filter), when the sheet is reopened and when the viewport width changes. It owns its own scroll,
 * so the Schedule behind it never moves until a row is chosen. It starts open and its header collapses it to a slim bar / reopens it; the
 * component is only mounted while a filter is applied, so clearing the filter drops it and applying one again opens it afresh. Collapsing
 * releases the page's reserved bottom space, which can make the browser pull the page up when it was scrolled near the end; reopening then
 * puts the page back where it was before the collapse, unless the user scrolled in between -- so the time slot they were looking at is the
 * one they come back to. A row is two sibling buttons (never one inside another): the row body goes to the slot, the avatar opens the
 * stream, and neither click reaches the other. */
export function ScheduleResultsDrawer({ locale, groups, onSelectResult, onSelectStream }: ScheduleResultsDrawerProps) {
  const [open, setOpen] = useState(true)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const [timeFormat] = useTimeFormat()
  const listId = useId()
  const asideRef = useRef<HTMLElement>(null)
  const headerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // The page scroll just before a collapse, and where the page ended up once collapsed (the browser may have clamped it).
  const scrollBeforeCollapse = useRef<number | null>(null)
  const scrollWhenCollapsed = useRef(0)
  const count = groups.reduce((total, group) => total + group.items.length, 0)
  const title = t(locale, "liveSchedule.resultsTitle", { count: String(count) })
  // Which creators the results are about: it changes with a new filter, not with a refresh of the same creators' events.
  const creatorSet = [...new Set(groups.flatMap((group) => group.items.map((item) => item.stream.channelId)))].sort().join(",")

  // Only a change of width re-measures on resize: a phone's collapsing address bar changes the height all the time and must not resize the sheet.
  useEffect(() => {
    /** Tracks the viewport width, the only resize that re-measures the sheet. */
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  // Measures the content and fixes the sheet to it (the CSS max-height still caps it), and tells the page how much room to reserve. Runs on open,
  // a new creator set and a new width only -- never on a plain data refresh. Declared before the scroll restore below: the reserved room must exist
  // before the page is scrolled back.
  useLayoutEffect(() => {
    const aside = asideRef.current
    const page = aside?.closest<HTMLElement>(".schedule-page")
    if (!aside) return
    if (!open) {
      aside.style.height = ""
      page?.style.removeProperty(RESULTS_HEIGHT_VAR)
      return
    }
    const header = headerRef.current
    const content = contentRef.current
    const style = getComputedStyle(aside)
    const chrome = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"].reduce((sum, key) => sum + (Number.parseFloat(style[key as "paddingTop"]) || 0), 0)
    const natural = (header?.offsetHeight ?? 0) + (content?.offsetHeight ?? 0) + chrome
    if (natural > 0) aside.style.height = `${natural}px`
    /** Publishes the sheet real height on the page so the grid keeps exactly that much room below it. */
    const publish = () => page?.style.setProperty(RESULTS_HEIGHT_VAR, `${aside.offsetHeight}px`)
    publish()
    // The CSS max-height follows the visible viewport, so the real height can change without a re-measure: keep the reserved room equal to it.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish)
    observer?.observe(aside)
    return () => {
      observer?.disconnect()
      page?.style.removeProperty(RESULTS_HEIGHT_VAR)
    }
  }, [open, creatorSet, viewportWidth])

  useLayoutEffect(() => {
    if (!open) {
      scrollWhenCollapsed.current = window.scrollY
      return
    }
    const before = scrollBeforeCollapse.current
    scrollBeforeCollapse.current = null
    if (before !== null && Math.abs(window.scrollY - scrollWhenCollapsed.current) < 1) window.scrollTo(0, before)
  }, [open])

  /** Collapses or reopens the sheet, remembering the page scroll when collapsing. */
  const toggle = () => {
    if (open) scrollBeforeCollapse.current = window.scrollY
    setOpen(!open)
  }

  // Choosing a row collapses the sheet so it cannot cover the event it just navigated to; the grid then scrolls to the slot once the collapsed layout
  // is in place. The user is going somewhere new, so a later reopen must not drag the page back to where it was before.
  /** Collapses the sheet and hands the chosen row to the grid, which switches day and scrolls to the slot. */
  const selectResult = (group: ScheduleResultGroup, item: ScheduleResultItem) => {
    scrollBeforeCollapse.current = null
    setOpen(false)
    onSelectResult(group, item)
  }

  return (
    <aside ref={asideRef} className={`schedule-results${open ? "" : " is-collapsed"}`} aria-label={title}>
      <button
        ref={headerRef}
        type="button"
        className="schedule-results__header"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`${title} - ${t(locale, open ? "liveSchedule.resultsCollapseAria" : "liveSchedule.resultsExpandAria")}`}
        onClick={toggle}
      >
        <span className="schedule-results__title">{title}</span>
        {open ? <ChevronDown size={20} aria-hidden="true" /> : <ChevronUp size={20} aria-hidden="true" />}
      </button>

      {open && (
        <div className="schedule-results__list" id={listId}>
          <div ref={contentRef} className="schedule-results__content">
            {groups.length === 0 && <div className="schedule-results__empty">{t(locale, "liveSchedule.resultsEmpty")}</div>}
            {groups.map((group) => (
              <section key={group.dayKey} className="schedule-results__group" data-day-key={group.dayKey}>
                <h3 className={`schedule-results__date${group.isToday ? " is-today" : ""}`}>
                  {group.date.toLocaleDateString(locale, { month: "numeric", day: "numeric", weekday: "short" })}
                </h3>
                <ul className="schedule-results__rows">
                  {group.items.map((item) => {
                    const { stream } = item
                    const name = getScheduleCreatorName(stream.channelId)
                    const visual = getScheduleCreatorAvatarVisual(stream.channelId, name)
                    return (
                      <li key={stream.id} className="schedule-results__row" data-video-id={stream.videoId}>
                        <button type="button" className="stream-avatar-button" onClick={() => onSelectStream(stream)} aria-label={stream.title}>
                          <span className="creator-avatar-circle stream-avatar" style={visual.avatarUrl ? undefined : { background: visual.background, color: visual.color }}>
                            {visual.avatarUrl ? <img src={visual.avatarUrl} alt="" /> : visual.initial}
                          </span>
                        </button>
                        <button type="button" className="schedule-results__goto" onClick={() => selectResult(group, item)}>
                          <span className="schedule-results__meta">
                            <span className="schedule-results__time">{formatClockTime(new Date(stream.scheduledStartMs), timeFormat)}</span>
                            {stream.status === "live" && <span className="schedule-results__badge is-live">{t(locale, "liveSchedule.liveBadge")}</span>}
                            {stream.status === "premiere" && <span className="schedule-results__badge is-premiere">{t(locale, "liveSchedule.premiereBadge")}</span>}
                            <span className="schedule-results__creator">{name}</span>
                          </span>
                          <span className="schedule-results__stream-title">{stream.title}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}
    </aside>
  )
}
