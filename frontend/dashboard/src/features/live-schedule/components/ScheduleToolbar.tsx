import { Select } from "antd"
import { ChevronLeft, ChevronRight, Filter } from "lucide-react"
import type { CreatorFilterOption } from "../model/scheduleCreatorFilter"
import { t, type Locale } from "../../../shared/i18n/translations"

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
 * local Date getters), never a fixed JST toggle. The week-selector arrows stay disabled: this phase's data is always the backend's own
 * fixed today-through-+6-day window (GET /live-streams' 168-hour lookahead, no persisted history), so there is nothing to page into.
 *
 * The creator filter is a searchable multi-select. Nothing selected = every creator's streams; otherwise exactly the selected
 * creators' streams (see scheduleCreatorFilter.ts). Favorites are listed first and can be added in one click. */
export function ScheduleToolbar({ locale, weekStart, creatorOptions, selectedCreators, onSelectedCreatorsChange }: ScheduleToolbarProps) {
  const favorites = creatorOptions.filter((option) => option.isFavorite)
  const others = creatorOptions.filter((option) => !option.isFavorite)
  const groups = [
    ...(favorites.length > 0
      ? [{ label: t(locale, "liveSchedule.filterFavoritesGroup"), options: favorites.map((option) => ({ value: option.channelId, label: option.name })) }]
      : []),
    { label: t(locale, "liveSchedule.filterAllGroup"), options: others.map((option) => ({ value: option.channelId, label: option.name })) },
  ].filter((group) => group.options.length > 0)

  const addFavorites = () => onSelectedCreatorsChange([...new Set([...selectedCreators, ...favorites.map((option) => option.channelId)])])

  return (
    <div className="schedule-toolbar">
      <div className="week-selector schedule-control">
        <button type="button" className="week-selector__arrow" disabled aria-label={t(locale, "liveSchedule.prevWeekAria")}>
          <ChevronLeft size={16} />
        </button>
        <span className="week-selector__label">{formatWeekRange(weekStart, locale)}</span>
        <button type="button" className="week-selector__arrow" disabled aria-label={t(locale, "liveSchedule.nextWeekAria")}>
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="filter-button schedule-control schedule-creator-filter" data-active={selectedCreators.length > 0}>
        <Filter size={16} aria-hidden="true" />
        <Select
          mode="multiple"
          showSearch
          allowClear
          variant="borderless"
          className="schedule-creator-filter__select"
          classNames={{ popup: { root: "schedule-creator-filter__dropdown" } }}
          maxTagCount={2}
          placeholder={t(locale, "liveSchedule.filterLabel")}
          aria-label={t(locale, "liveSchedule.filterAriaLabel")}
          optionFilterProp="label"
          value={selectedCreators}
          options={groups}
          onChange={(next: string[]) => onSelectedCreatorsChange(next)}
          notFoundContent={t(locale, "liveSchedule.filterNoMatch")}
          popupRender={(menu) => (
            <>
              {menu}
              <div className="schedule-creator-filter__footer">
                {favorites.length > 0 && (
                  <button type="button" className="schedule-creator-filter__action" onMouseDown={(event) => event.preventDefault()} onClick={addFavorites}>
                    {t(locale, "liveSchedule.filterAddFavorites")} ({favorites.length})
                  </button>
                )}
                {selectedCreators.length > 0 && (
                  <button
                    type="button"
                    className="schedule-creator-filter__action"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onSelectedCreatorsChange([])}
                  >
                    {t(locale, "liveSchedule.filterClear")}
                  </button>
                )}
              </div>
            </>
          )}
        />
      </div>
    </div>
  )
}
