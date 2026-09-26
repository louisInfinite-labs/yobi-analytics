import { ChevronLeft, ChevronRight, Filter, Globe2 } from "lucide-react"
import { t, type Locale } from "../../../shared/i18n/translations"

interface ScheduleToolbarProps {
  locale: Locale
  weekStart: Date
  onPreviousWeek: () => void
  onNextWeek: () => void
}

function formatWeekRange(weekStart: Date, locale: Locale): string {
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekEnd.getDate() + 6)
  const formatter = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" })
  return `${formatter.format(weekStart)} - ${formatter.format(weekEnd)}`
}

/** Timezone/Filter render per the approved reference image but aren't wired
 * to real behavior (no timezone-conversion or filtering logic exists to back
 * them) -- native `disabled` rather than a fake, clickable no-op, same
 * "don't pretend to be functional" call already made for Home's Oshi Videos
 * View All button. */
export function ScheduleToolbar({ locale, weekStart, onPreviousWeek, onNextWeek }: ScheduleToolbarProps) {
  return (
    <div className="schedule-toolbar">
      <div className="week-selector schedule-control">
        <button type="button" className="week-selector__arrow" onClick={onPreviousWeek} aria-label={t(locale, "liveSchedule.prevWeekAria")}>
          <ChevronLeft size={16} />
        </button>
        <span className="week-selector__label">{formatWeekRange(weekStart, locale)}</span>
        <button type="button" className="week-selector__arrow" onClick={onNextWeek} aria-label={t(locale, "liveSchedule.nextWeekAria")}>
          <ChevronRight size={16} />
        </button>
      </div>

      <button type="button" className="timezone-button schedule-control" disabled>
        <Globe2 size={16} />
        {t(locale, "liveSchedule.timezoneLabel")}
      </button>

      <button type="button" className="filter-button schedule-control" disabled>
        <Filter size={16} />
        {t(locale, "liveSchedule.filterLabel")}
      </button>
    </div>
  )
}
