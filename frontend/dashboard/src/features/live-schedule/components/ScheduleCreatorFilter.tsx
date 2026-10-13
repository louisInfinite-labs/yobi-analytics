import { useMemo, useRef, useState } from "react"
import { Drawer } from "antd"
import { Filter, Heart, Search } from "lucide-react"
import { CreatorAvatarImage } from "../../../entities/creator/components/CreatorAvatarImage"
import { toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { LiveStatusGroups } from "../../live-status/components/LiveStatusGroups"
import { groupEligibleCreatorsForLiveStatus } from "../../live-status/utils/liveStatusCanonicalRoster"
import { t, type Locale } from "../../../shared/i18n/translations"
import { HomeFilterSegmented } from "../../../shared/ui/HomeFilterSegmented"
import type { CreatorFilterOption, ScheduleOrganizationFilter } from "../model/scheduleCreatorFilter"

interface ScheduleCreatorFilterProps {
  locale: Locale
  /** The creators the filter can pick (those with a stream in the schedule, plus any currently selected one). */
  creatorOptions: CreatorFilterOption[]
  /** The selected creators' legacy channel ids; empty = no filter. */
  selectedCreators: string[]
  onSelectedCreatorsChange: (channelIds: string[]) => void
  /** The organization filter, shown first in the drawer: "all" = no organization restriction. */
  organization: ScheduleOrganizationFilter
  onOrganizationChange: (organization: ScheduleOrganizationFilter) => void
}

/** The Schedule page's creator filter: a trigger button that opens a RIGHT-SIDE drawer. An EMPTY selection means "no filter" (every
 * creator's streams); otherwise exactly the selected creators' streams (scheduleCreatorFilter.ts) -- nothing about that changed, only the
 * presentation did.
 *
 * Grouping, group order, member order and the "VSPO! // JP" headings are Live Status': the creators come from
 * groupEligibleCreatorsForLiveStatus and the layout from LiveStatusGroups, never a Schedule-specific sort. The search, drawer surface and
 * hover/selected tones are Home's (--oshi-* tokens and the same .live-status-search / .live-status-group__* classes); each creator is the
 * shared creator tile (the corrected 收藏名單 tile: the Live Status avatar on top with no ring or glow, the name centered directly below it,
 * the Live Status favorite heart on the avatar), three to a row in the drawer. Schedule has no tile CSS of its own beyond its colors. */
export function ScheduleCreatorFilter({
  locale,
  creatorOptions,
  selectedCreators,
  onSelectedCreatorsChange,
  organization,
  onOrganizationChange,
}: ScheduleCreatorFilterProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const selectedSet = useMemo(() => new Set(selectedCreators), [selectedCreators])
  const availableIds = useMemo(() => new Set(creatorOptions.map((option) => option.channelId)), [creatorOptions])
  const favoriteIds = useMemo(() => creatorOptions.filter((option) => option.isFavorite).map((option) => option.channelId), [creatorOptions])
  const favoriteSet = useMemo(() => new Set(favoriteIds), [favoriteIds])

  const groups = useMemo(
    () => groupEligibleCreatorsForLiveStatus(query, (creator) => availableIds.has(toLegacyRosterId(creator))),
    [query, availableIds],
  )

  // The newest selection, updated the instant a change is made -- so two changes before the parent re-renders (a fast double click) both land.
  const latestSelection = useRef(selectedCreators)
  latestSelection.current = selectedCreators
  const commit = (next: string[]) => {
    latestSelection.current = next
    onSelectedCreatorsChange(next)
  }
  const toggle = (channelId: string) => {
    const current = latestSelection.current
    commit(current.includes(channelId) ? current.filter((id) => id !== channelId) : [...current, channelId])
  }
  const addFavorites = () => commit([...new Set([...latestSelection.current, ...favoriteIds])])
  const close = () => {
    setOpen(false)
    setQuery("")
  }

  return (
    <>
      <button
        type="button"
        className="filter-button schedule-control schedule-creator-filter"
        data-active={selectedCreators.length > 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t(locale, "liveSchedule.filterAriaLabel")}
        onClick={() => setOpen(true)}
      >
        <Filter size={16} aria-hidden="true" />
        <span>{t(locale, "liveSchedule.filterLabel")}</span>
        {selectedCreators.length > 0 && <span className="schedule-creator-filter__count">{selectedCreators.length}</span>}
      </button>

      <Drawer
        open={open}
        onClose={close}
        placement="right"
        size={520}
        title={t(locale, "liveSchedule.filterAriaLabel")}
        rootClassName="schedule-creator-drawer"
        destroyOnHidden
      >
        <div className="schedule-creator-drawer__organization">
          <HomeFilterSegmented<ScheduleOrganizationFilter>
            rootClassName="schedule-organization-segmented"
            labelClassName="schedule-organization-segment-label"
            aria-label={t(locale, "liveSchedule.organizationFilterAriaLabel")}
            value={organization}
            onChange={onOrganizationChange}
            options={[
              { value: "all", label: t(locale, "liveSchedule.organizationAll") },
              { value: "vspo", label: t(locale, "liveSchedule.organizationVspo") },
              { value: "hololive", label: t(locale, "liveSchedule.organizationHololive") },
            ]}
          />
        </div>

        <div className="schedule-creator-drawer__controls">
          <label className="live-status-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="text"
              placeholder={t(locale, "oshiSettings.searchPlaceholder")}
              aria-label={t(locale, "oshiSettings.searchPlaceholder")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="schedule-creator-drawer__actions">
            <span className="schedule-creator-drawer__selected-count">
              {t(locale, "liveSchedule.filterSelectedCount", { count: String(selectedCreators.length) })}
            </span>
            {favoriteIds.length > 0 && (
              <button type="button" className="schedule-creator-drawer__action" onClick={addFavorites}>
                {t(locale, "liveSchedule.filterAddFavorites")} ({favoriteIds.length})
              </button>
            )}
            {selectedCreators.length > 0 && (
              <button type="button" className="schedule-creator-drawer__action" onClick={() => commit([])}>
                {t(locale, "liveSchedule.filterClear")}
              </button>
            )}
          </div>
        </div>

        <div className="schedule-creator-drawer__list">
          {groups.length === 0 ? (
            <div className="oshi-empty-state">{t(locale, "liveSchedule.filterNoMatch")}</div>
          ) : (
            <LiveStatusGroups
              groups={groups}
              locale={locale}
              renderSubgroup={(creators) => (
                <div className="creator-tile-grid schedule-creator-grid">
                  {creators.map((creator) => {
                    const channelId = toLegacyRosterId(creator)
                    const selected = selectedSet.has(channelId)
                    return (
                      <button
                        key={creator.creatorId}
                        type="button"
                        className="creator-tile schedule-creator-item"
                        aria-pressed={selected}
                        data-channel-id={channelId}
                        onClick={() => toggle(channelId)}
                      >
                        <span className="creator-tile__avatar-wrap">
                          <CreatorAvatarImage avatarUrl={creator.avatarUrl} displayName={creator.displayName} className="schedule-creator-item__avatar" />
                          {favoriteSet.has(channelId) && <Heart className="creator-avatar-heart" aria-hidden="true" fill="currentColor" />}
                        </span>
                        <span className="creator-tile__name schedule-creator-item__name">{creator.displayName}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            />
          )}
        </div>
      </Drawer>
    </>
  )
}
