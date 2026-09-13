import { useState } from "react"
import { ConfigProvider, Input, Switch } from "antd"
import { SearchOutlined } from "@ant-design/icons"
import { useLocale } from "../../hooks/useLocale"
import { useCreatorNotificationPreferences } from "../../hooks/useCreatorNotificationPreferences"
import {
  GAMERS_GROUP_LABEL_KEY,
  groupCreatorsForNotificationSettings,
  OTHER_GROUP_LABEL_KEY,
  type CreatorAgencyGroup,
  type NotificationCreator,
} from "../../lib/notificationCreatorGrouping"
import { t, type Locale } from "../../i18n/translations"
import { useMemberTheme } from "../../theme/ThemeContext"

/** Every subgroup label is a real, locale-independent group/generation
 * name (e.g. "1期生", "Myth") EXCEPT the two sentinel keys below, each
 * swapped for its own translated wording here instead of being rendered
 * directly: the catch-all "Other" bucket (OTHER_GROUP_LABEL_KEY), and
 * Gamers (GAMERS_GROUP_LABEL_KEY, confirmed wording: "Gamers" in both
 * zh-TW and English, "ゲーマーズ" in Japanese -- not a plain pass-through
 * like the other proper-noun labels here). */
function subgroupTitle(locale: Locale, label: string): string {
  if (label === OTHER_GROUP_LABEL_KEY) return t(locale, "notificationSettings.otherGroupLabel")
  if (label === GAMERS_GROUP_LABEL_KEY) return t(locale, "notificationSettings.gamersGroupLabel")
  return label
}

/** Instant client-side filter, matched against the creator's own
 * (possibly already Japanese-name-overridden) displayName -- an empty or
 * whitespace-only query matches everyone. Never touches notification
 * switch state, only which rows render. */
function matchesSearch(creator: NotificationCreator, query: string): boolean {
  const trimmed = query.trim().toLowerCase()
  return trimmed === "" || creator.displayName.toLowerCase().includes(trimmed)
}

/** Filters the WHOLE Agency > Region > Subgroup > Creator hierarchy, not
 * just individual creator rows -- a subgroup/region/agency is dropped
 * entirely once it has zero matching creators left, so a search never
 * leaves an empty heading, column header, or divider on screen (this is
 * the actual fix: the earlier version only filtered which CreatorRows
 * rendered while every parent heading stayed mounted regardless). */
function filterAgencyGroups(agencyGroups: CreatorAgencyGroup[], query: string): CreatorAgencyGroup[] {
  return agencyGroups
    .map((agency) => ({
      ...agency,
      regions: agency.regions
        .map((region) => ({
          ...region,
          subgroups: region.subgroups
            .map((subgroup) => ({
              ...subgroup,
              creators: subgroup.creators.filter((creator) => matchesSearch(creator, query)),
            }))
            .filter((subgroup) => subgroup.creators.length > 0),
        }))
        .filter((region) => region.subgroups.length > 0),
    }))
    .filter((agency) => agency.regions.length > 0)
}

function CreatorRow({ creator }: { creator: NotificationCreator }) {
  const [locale] = useLocale()
  const { isLiveSubscribed, isNewVideoSubscribed, setLiveSubscribed, setNewVideoSubscribed } =
    useCreatorNotificationPreferences()

  return (
    <div className="notification-settings__row">
      <span className="notification-settings__avatar" aria-hidden="true">
        {creator.displayName.trim().charAt(0)}
      </span>
      <span className="notification-settings__creator-name">{creator.displayName}</span>
      <span className="notification-settings__switch-cell">
        <Switch
          checked={isLiveSubscribed(creator.creatorId)}
          onChange={(checked) => setLiveSubscribed(creator.creatorId, checked)}
          aria-label={t(locale, "notificationSettings.liveSwitchAriaLabel", { name: creator.displayName })}
        />
      </span>
      <span className="notification-settings__switch-cell">
        <Switch
          checked={isNewVideoSubscribed(creator.creatorId)}
          onChange={(checked) => setNewVideoSubscribed(creator.creatorId, checked)}
          aria-label={t(locale, "notificationSettings.newVideoSwitchAriaLabel", { name: creator.displayName })}
        />
      </span>
    </div>
  )
}

function ColumnHeader() {
  const [locale] = useLocale()
  return (
    <div className="notification-settings__column-header">
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      <span className="notification-settings__column-header-label">{t(locale, "notificationSettings.liveColumnHeader")}</span>
      <span className="notification-settings__column-header-label">
        {t(locale, "notificationSettings.newVideoColumnHeader")}
      </span>
    </div>
  )
}

/** Notification Settings' content: every creator in the real Creator
 * Master roster (src/lib/notificationCreatorGrouping.ts -- 112 as of
 * this roster, not the small mockCreators.ts used elsewhere), in the
 * spec's own three-level hierarchy -- Agency (VSPO/HOLOLIVE) > Region
 * (JP/EN/ID) > Generation/Unit > one creator per row, never more than
 * one creator on a line. Each row has two independent switches (live,
 * then new video -- see useCreatorNotificationPreferences), both on by
 * default. */
export function NotificationSettings() {
  const agencyGroups = groupCreatorsForNotificationSettings()
  const { theme } = useMemberTheme()
  const [locale] = useLocale()
  const [searchQuery, setSearchQuery] = useState("")

  const filteredAgencyGroups = filterAgencyGroups(agencyGroups, searchQuery)
  const hasResults = filteredAgencyGroups.length > 0
  // The search box's own heading row always shows the first SURVIVING
  // agency's label (falling back to the real first agency, e.g. "VSPO",
  // once none survive) -- its position never moves, but which agency it
  // sits beside can change as the query narrows results down to a single
  // agency (see filterAgencyGroups above).
  const headerAgencyLabel = filteredAgencyGroups[0]?.agencyLabel ?? agencyGroups[0]?.agencyLabel ?? ""

  return (
    // Scoped to this component's own subtree only (antd's ConfigProvider
    // affects only the antd components rendered inside it, and Switch is
    // the only antd component used anywhere in this app) -- ON uses this
    // app's own active theme primary color without any global antd theme
    // setup or CSS reset.
    <ConfigProvider theme={{ token: { colorPrimary: theme.primary } }}>
      <div className="notification-settings">
        <div className="notification-settings__agency-header">
          <h2 className="notification-settings__agency-title">{headerAgencyLabel}</h2>
          <Input
            className="notification-settings__search"
            prefix={<SearchOutlined />}
            placeholder={t(locale, "notificationSettings.searchPlaceholder")}
            allowClear
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>
        {!hasResults && <p className="notification-settings__empty-state">{t(locale, "notificationSettings.noResults")}</p>}
        {filteredAgencyGroups.map((agency, agencyIndex) => (
          <section
            key={agency.agencyLabel}
            className={
              agencyIndex === 0
                ? "notification-settings__agency"
                : "notification-settings__agency notification-settings__agency--divided"
            }
          >
            {/* The first surviving agency's own title already renders in
             * the search header above -- only later agencies repeat it
             * here. */}
            {agencyIndex > 0 && <h2 className="notification-settings__agency-title">{agency.agencyLabel}</h2>}
            {agency.regions.map((region) => (
              <div key={region.branch} className="notification-settings__region">
                <h3 className="notification-settings__region-title">{region.regionLabel}</h3>
                {region.subgroups.map((subgroup) => (
                  <div key={subgroup.label ?? "__flat__"} className="notification-settings__subgroup">
                    {subgroup.label && (
                      <h4 className="notification-settings__subgroup-title">{subgroupTitle(locale, subgroup.label)}</h4>
                    )}
                    <ColumnHeader />
                    <div className="notification-settings__list">
                      {subgroup.creators.map((creator) => (
                        <CreatorRow key={creator.creatorId} creator={creator} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </section>
        ))}
      </div>
    </ConfigProvider>
  )
}
