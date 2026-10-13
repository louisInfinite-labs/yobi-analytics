import { ChevronLeft, ChevronRight } from "lucide-react"
import type { ScheduleDay } from "../hooks/useWeeklySchedule"
import { t, type Locale } from "../../../shared/i18n/translations"

interface ScheduleDayNavigatorProps {
  locale: Locale
  days: ScheduleDay[]
  selectedIndex: number
  onSelectIndex: (index: number) => void
}

/** The phone Schedule's date header: `<  selected date  >`. It only moves within the days already loaded (the first day disables "<", the
 * last disables ">"), so switching day never asks the backend for anything. Sticky under the phone top bar (schedule.css). */
export function ScheduleDayNavigator({ locale, days, selectedIndex, onSelectIndex }: ScheduleDayNavigatorProps) {
  const selected = days[selectedIndex]
  if (!selected) return null
  const label = selected.date.toLocaleDateString(locale, { month: "numeric", day: "numeric", weekday: "short" })

  return (
    <nav className="schedule-day-nav" aria-label={t(locale, "liveSchedule.dayNavAria")}>
      <button
        type="button"
        className="schedule-day-nav__arrow"
        disabled={selectedIndex <= 0}
        onClick={() => onSelectIndex(selectedIndex - 1)}
        aria-label={t(locale, "liveSchedule.previousDayAria")}
      >
        <ChevronLeft size={20} aria-hidden="true" />
      </button>
      <div className={`schedule-day-nav__label${selected.isToday ? " is-today" : ""}`} aria-live="polite" data-date={selected.date.toDateString()}>
        {label}
      </div>
      <button
        type="button"
        className="schedule-day-nav__arrow"
        disabled={selectedIndex >= days.length - 1}
        onClick={() => onSelectIndex(selectedIndex + 1)}
        aria-label={t(locale, "liveSchedule.nextDayAria")}
      >
        <ChevronRight size={20} aria-hidden="true" />
      </button>
    </nav>
  )
}
