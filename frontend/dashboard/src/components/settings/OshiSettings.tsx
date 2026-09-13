import { useState } from "react"
import { Checkbox, ConfigProvider } from "antd"
import type { MockCreator } from "../../data/mockCreators"
import { useFavoriteCreators } from "../../hooks/useFavoriteCreators"
import { useLocale } from "../../hooks/useLocale"
import { t, type Locale } from "../../i18n/translations"
import {
  GAMERS_GROUP_LABEL_KEY,
  groupCreatorsForOshiSettings,
  OTHER_GROUP_LABEL_KEY,
} from "../../lib/oshiSettingsGrouping"
import { useMemberTheme } from "../../theme/ThemeContext"

/** Every subgroup label is a real, locale-independent group/generation name
 * (e.g. "1期生", "Myth") EXCEPT the two sentinel keys below, each swapped
 * for its own translated wording here -- same sentinel-label pattern as
 * NotificationSettings' own subgroupTitle. */
function subgroupTitle(locale: Locale, label: string): string {
  if (label === OTHER_GROUP_LABEL_KEY) return t(locale, "oshiSettings.otherGroupLabel")
  if (label === GAMERS_GROUP_LABEL_KEY) return t(locale, "oshiSettings.gamersGroupLabel")
  return label
}

/** One creator tile: avatar + name + a favorite Checkbox, all reading/
 * writing the SAME shared favorites store Live Status itself uses
 * (useFavoriteCreators) -- checking/unchecking here is immediately visible
 * as Live Status's own favorite heart/favorites-view filter, and vice
 * versa, since both read the identical Set<channelId>. This is a favorite
 * membership toggle, not a Live Status visibility control -- unchecking a
 * creator here never hides them from Live Status. */
function CreatorTile({ creator }: { creator: MockCreator }) {
  const [locale] = useLocale()
  const { favorites, toggleFavorite } = useFavoriteCreators()
  const isFavorite = favorites.has(creator.channelId)
  // A handful of names carry explicit "\n" line breaks for their on-screen
  // display (see mockCreators.ts) -- collapsed back to spaces here so the
  // checkbox's own aria-label reads as one normal sentence, not literal
  // newlines.
  const spokenName = creator.channelName.replace(/\n/g, " ")

  return (
    <div className="oshi-settings__card">
      <div className="oshi-settings__card-top">
        <span className="oshi-settings__avatar-wrap">
          <span className="oshi-settings__avatar" aria-hidden="true">
            {creator.channelName.charAt(0)}
          </span>
          <Checkbox
            className="oshi-settings__checkbox"
            checked={isFavorite}
            onChange={() => toggleFavorite(creator.channelId)}
            aria-label={t(locale, isFavorite ? "oshiSettings.removeFavoriteAria" : "oshiSettings.addFavoriteAria", {
              name: spokenName,
            })}
          />
        </span>
      </div>
      <span className="oshi-settings__creator-name">{creator.channelName}</span>
    </div>
  )
}

/** Oshi Settings' content: favorite management for every creator in Live
 * Status's own roster (mockCreators, via groupCreatorsForOshiSettings --
 * same creators/IDs/order Live Status itself already groups by), rendered
 * as Agency (VSPO/Hololive) > Region (JP/EN/ID) > a responsive creator
 * grid. This page is purely about WHICH creators are favorited -- it has
 * no bearing on which creators Live Status displays at all (that's a
 * separate, unrelated data source/rule this page never touches). */
export function OshiSettings() {
  const [locale] = useLocale()
  const { theme } = useMemberTheme()
  const [searchQuery, setSearchQuery] = useState("")

  const agencyGroups = groupCreatorsForOshiSettings(searchQuery)
  const hasResults = agencyGroups.length > 0
  // Mirrors NotificationSettings' own search-header pattern: the search box
  // always sits on the first SURVIVING agency's heading row (falling back
  // to an empty spacer, never an unrelated agency name, once nothing
  // matches) so its position never moves regardless of query.
  const headerAgencyLabel = agencyGroups[0]?.agencyLabel ?? null

  return (
    // Scoped to this component's own subtree only -- antd's Checkbox is the
    // only antd control used here, themed off this app's own active member
    // color the same way NotificationSettings' Switch already is.
    <ConfigProvider theme={{ token: { colorPrimary: theme.primary } }}>
      <div className="oshi-settings">
        <div className="oshi-settings__agency-header">
          {headerAgencyLabel ? (
            <h2 className="oshi-settings__agency-title">{headerAgencyLabel}</h2>
          ) : (
            <span className="oshi-settings__agency-title" aria-hidden="true" />
          )}
          <input
            type="text"
            className="oshi-settings__search"
            placeholder={t(locale, "oshiSettings.searchPlaceholder")}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>
        {!hasResults && <p className="oshi-settings__empty-state">{t(locale, "oshiSettings.noResults")}</p>}
        {agencyGroups.map((agency, agencyIndex) => (
          <section
            key={agency.agencyLabel}
            className={
              agencyIndex === 0 ? "oshi-settings__agency" : "oshi-settings__agency oshi-settings__agency--divided"
            }
          >
            {agencyIndex > 0 && <h2 className="oshi-settings__agency-title">{agency.agencyLabel}</h2>}
            {agency.regions.map((region) => (
              <div key={region.branch} className="oshi-settings__region">
                <h3 className="oshi-settings__region-title">{region.regionLabel}</h3>
                {region.subgroups.map((subgroup) => (
                  <div key={subgroup.label ?? "__flat__"} className="oshi-settings__subgroup">
                    {subgroup.label && (
                      <h4 className="oshi-settings__subgroup-title">{subgroupTitle(locale, subgroup.label)}</h4>
                    )}
                    <div className="oshi-settings__grid">
                      {subgroup.creators.map((creator) => (
                        <CreatorTile key={creator.channelId} creator={creator} />
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
