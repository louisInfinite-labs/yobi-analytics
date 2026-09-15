import { useState } from "react"
import { ConfigProvider, Radio } from "antd"
import type { MockCreator } from "../../data/mockCreators"
import { useDefaultOshiCreator } from "../../hooks/useDefaultOshiCreator"
import { useLocale } from "../../hooks/useLocale"
import { t, type Locale } from "../../i18n/translations"
import { isEligibleForMyOshi } from "../../lib/myOshiEligibility"
import { GAMERS_GROUP_LABEL_KEY, groupCreatorsForOshiSettings, OTHER_GROUP_LABEL_KEY } from "../../lib/oshiSettingsGrouping"
import { useMemberTheme } from "../../theme/ThemeContext"

/** Same sentinel-label swap as OshiSettings.tsx's own subgroupTitle --
 * these two pages share the exact same grouping/labels (see
 * groupCreatorsForOshiSettings), so the same two sentinel keys apply. */
function subgroupTitle(locale: Locale, label: string): string {
  if (label === OTHER_GROUP_LABEL_KEY) return t(locale, "oshiSettings.otherGroupLabel")
  if (label === GAMERS_GROUP_LABEL_KEY) return t(locale, "oshiSettings.gamersGroupLabel")
  return label
}

/** One creator tile -- same layout as OshiSettings.tsx's own CreatorTile
 * (avatar + name + a selection control 16px to its right), swapping the
 * favorites Checkbox for a single-select Radio against
 * useDefaultOshiCreator's own persisted pick (confirmed with the user: at
 * most one creator selected at any time, picking another one here replaces
 * it -- native single <Radio> semantics already guarantee this without any
 * extra "deselect the previous one" logic). */
function CreatorTile({ creator }: { creator: MockCreator }) {
  const [locale] = useLocale()
  const [defaultOshiId, setDefaultOshiId] = useDefaultOshiCreator()
  const isSelected = defaultOshiId === creator.channelId
  const spokenName = creator.channelName.replace(/\n/g, " ")

  return (
    <div className="oshi-settings__card">
      <div className="oshi-settings__card-top">
        <span className="oshi-settings__avatar-wrap">
          <span className="oshi-settings__avatar" aria-hidden="true">
            {creator.channelName.charAt(0)}
          </span>
          <Radio
            className="my-oshi-settings__radio"
            checked={isSelected}
            onChange={() => setDefaultOshiId(creator.channelId)}
            aria-label={t(locale, "myOshiSettings.selectAria", { name: spokenName })}
          />
        </span>
      </div>
      <span className="oshi-settings__creator-name">{creator.channelName}</span>
    </div>
  )
}

/** Settings > 我推設定: pick the single creator Home shows on a fresh app
 * startup (see useDefaultOshiCreator.ts). Reuses OshiSettings.tsx's (收藏
 * 名單, the Favorites List page) exact Agency > Region > Generation/Unit
 * grid layout, search, and CSS classes per the user's own explicit
 * requirement -- only the selection control and its underlying state
 * differ. VSPO's own official channel and hololive Production Staff are
 * excluded from this list (see lib/myOshiEligibility.ts); every other
 * creator, including Hololive's own group-unit channels (ReGLOSS/FLOW
 * GLOW/FUWAMOCO/mekPark), remains selectable. */
export function MyOshiSettings() {
  const [locale] = useLocale()
  const { theme } = useMemberTheme()
  const [searchQuery, setSearchQuery] = useState("")

  const agencyGroups = groupCreatorsForOshiSettings(searchQuery, isEligibleForMyOshi)
  const hasResults = agencyGroups.length > 0
  const headerAgencyLabel = agencyGroups[0]?.agencyLabel ?? null

  return (
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
            className={agencyIndex === 0 ? "oshi-settings__agency" : "oshi-settings__agency oshi-settings__agency--divided"}
          >
            {agencyIndex > 0 && <h2 className="oshi-settings__agency-title">{agency.agencyLabel}</h2>}
            {agency.regions.map((region) => (
              <div key={region.branch} className="oshi-settings__region">
                <h3 className="oshi-settings__region-title">{region.regionLabel}</h3>
                {region.subgroups.map((subgroup) => (
                  <div key={subgroup.label ?? "__flat__"} className="oshi-settings__subgroup">
                    {subgroup.label && <h4 className="oshi-settings__subgroup-title">{subgroupTitle(locale, subgroup.label)}</h4>}
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
