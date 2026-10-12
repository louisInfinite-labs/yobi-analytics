import { ScheduleCreatorFilter } from "./ScheduleCreatorFilter"
import type { CreatorFilterOption } from "../model/scheduleCreatorFilter"
import type { Locale } from "../../../shared/i18n/translations"

interface ScheduleToolbarProps {
  locale: Locale
  weekStart: Date
  /** Creators the filter can pick (those with a stream in the schedule, favorites first). */
  creatorOptions: CreatorFilterOption[]
  /** The selected creators' channel ids; empty = no filter. */
  selectedCreators: string[]
  onSelectedCreatorsChange: (channelIds: string[]) => void
}

function formatWeekRange(weekStart: Date, locale: Locale): string {
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekEnd.getDate() + 6)
  const formatter = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" })
  return `${formatter.format(weekStart)} - ${formatter.format(weekEnd)}`
}

/** No manual timezone control -- the whole page is placed by the viewer's own browser/device timezone (see scheduleGrid.ts's use of
 * local Date getters), never a fixed JST toggle. The week range is a plain label with no previous/next arrows: this phase's data is always
 * the backend's own fixed today-through-+6-day window (GET /live-streams' 168-hour lookahead, no persisted history), so there is nothing to page into.
 *
 * The creator filter opens a right-side drawer (ScheduleCreatorFilter): a searchable multi-select grouped and ordered like Live Status. Nothing
 * selected = every creator's streams; otherwise exactly the selected creators' streams (see scheduleCreatorFilter.ts). */
export function ScheduleToolbar({ locale, weekStart, creatorOptions, selectedCreators, onSelectedCreatorsChange }: ScheduleToolbarProps) {
  return (
    <div className="schedule-toolbar">
      <div className="week-selector schedule-control">
        <span className="week-selector__label">{formatWeekRange(weekStart, locale)}</span>
      </div>

      <ScheduleCreatorFilter
        locale={locale}
        creatorOptions={creatorOptions}
        selectedCreators={selectedCreators}
        onSelectedCreatorsChange={onSelectedCreatorsChange}
      />
    </div>
  )
}
