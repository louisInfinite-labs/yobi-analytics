import { useState, type CSSProperties } from "react"
import { Avatar, ConfigProvider, Input, Segmented } from "antd"
import { Crosshair, Search } from "lucide-react"
import type { MockCreator } from "../../../entities/creator/data/mockCreators"
import { useDefaultOshiCreator } from "../hooks/useDefaultOshiCreator"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t, type Locale } from "../../../shared/i18n/translations"
import { isEligibleForMyOshi } from "../utils/myOshiEligibility"
import {
  GAMERS_GROUP_LABEL_KEY,
  groupCreatorsForOshiSettings,
  OTHER_GROUP_LABEL_KEY,
  type OshiSettingsAgencyGroup,
} from "../utils/oshiSettingsGrouping"
import { getMemberAccent } from "../../../shared/theme/memberAccent"
import { useMemberTheme } from "../../../shared/theme/ThemeContext"

type CreatorAccentStyle = CSSProperties & {
  "--creator-accent": string
  "--creator-accent-soft": string
  "--creator-accent-text": string
}

interface SelectedCreatorPlacement {
  creator: MockCreator
  agencyLabel: string
  regionLabel: string
  subgroupLabel?: string
}

/** Same sentinel-label swap as OshiSettings.tsx's own subgroupTitle --
 * these two pages share the exact same grouping/labels (see
 * groupCreatorsForOshiSettings), so the same two sentinel keys apply. */
function subgroupTitle(locale: Locale, label: string): string {
  if (label === OTHER_GROUP_LABEL_KEY) return t(locale, "oshiSettings.otherGroupLabel")
  if (label === GAMERS_GROUP_LABEL_KEY) return t(locale, "oshiSettings.gamersGroupLabel")
  return label
}

function creatorAccentStyle(creator: MockCreator): CreatorAccentStyle {
  const accent = getMemberAccent(creator.channelId)
  return {
    "--creator-accent": accent.primary,
    "--creator-accent-soft": accent.soft,
    "--creator-accent-text": accent.textAccent,
  }
}

function formatRegionHeading(agencyLabel: string, regionLabel: string): string {
  const displayAgency = agencyLabel === "VSPO" ? "VSPO!" : agencyLabel.toUpperCase()
  return `${displayAgency} // ${regionLabel}`
}

function findSelectedCreatorPlacement(
  agencyGroups: OshiSettingsAgencyGroup[],
  creatorId: string,
): SelectedCreatorPlacement | null {
  for (const agency of agencyGroups) {
    for (const region of agency.regions) {
      for (const subgroup of region.subgroups) {
        const creator = subgroup.creators.find((candidate) => candidate.channelId === creatorId)
        if (creator) {
          return {
            creator,
            agencyLabel: agency.agencyLabel,
            regionLabel: region.regionLabel,
            subgroupLabel: subgroup.label ?? undefined,
          }
        }
      }
    }
  }
  return null
}

function CreatorAvatar({ creator, variant }: { creator: MockCreator; variant: "slot" | "hero" }) {
  const spokenName = creator.channelName.replace(/\n/g, " ")

  return (
    <Avatar
      className={`my-oshi-select__avatar my-oshi-select__avatar--${variant}`}
      src={creator.avatarUrl}
      alt={creator.avatarUrl ? spokenName : undefined}
    >
      {creator.channelName.charAt(0)}
    </Avatar>
  )
}

function CreatorSegmentLabel({ creator }: { creator: MockCreator }) {
  return (
    <span className="my-oshi-select__slot" style={creatorAccentStyle(creator)}>
      <span className="my-oshi-select__slot-avatar-frame">
        <CreatorAvatar creator={creator} variant="slot" />
      </span>
      <span className="my-oshi-select__slot-name">{creator.channelName}</span>
    </span>
  )
}

function SelectedCreatorPanel({ placement, locale }: { placement: SelectedCreatorPlacement; locale: Locale }) {
  const groupLabel = placement.subgroupLabel ? subgroupTitle(locale, placement.subgroupLabel) : null

  return (
    <aside
      className="my-oshi-select__presentation"
      style={creatorAccentStyle(placement.creator)}
      aria-label={t(locale, "myOshiSettings.presentationAria", { name: placement.creator.channelName.replace(/\n/g, " ") })}
    >
      <div className="my-oshi-select__presentation-grid" aria-hidden="true" />
      <div className="my-oshi-select__status-marker">
        <Crosshair size={14} aria-hidden="true" />
        {t(locale, "myOshiSettings.statusMarker")}
      </div>
      <div className="my-oshi-select__hero-avatar-frame">
        <CreatorAvatar creator={placement.creator} variant="hero" />
      </div>
      <div className="my-oshi-select__identity">
        <h2 className="my-oshi-select__selected-name">{placement.creator.channelName}</h2>
        <p className="my-oshi-select__selected-meta">
          {formatRegionHeading(placement.agencyLabel, placement.regionLabel)}
          {groupLabel ? ` / ${groupLabel}` : ""}
        </p>
      </div>
    </aside>
  )
}

/** Settings > 我推設定: pick the single creator Home shows on a fresh app
 * startup (see useDefaultOshiCreator.ts). This page intentionally keeps
 * that persistent defaultOshi state separate from Home's in-session
 * currentOshi; the redesign below only changes presentation. */
export function MyOshiSettings() {
  const [locale] = useLocale()
  const { theme } = useMemberTheme()
  const [defaultOshiId, setDefaultOshiId] = useDefaultOshiCreator()
  const [searchQuery, setSearchQuery] = useState("")

  const allAgencyGroups = groupCreatorsForOshiSettings("", isEligibleForMyOshi)
  const agencyGroups = groupCreatorsForOshiSettings(searchQuery, isEligibleForMyOshi)
  const selectedPlacement = findSelectedCreatorPlacement(allAgencyGroups, defaultOshiId)
  const fallbackPlacement = allAgencyGroups[0]?.regions[0]?.subgroups[0]?.creators[0]
    ? {
        creator: allAgencyGroups[0].regions[0].subgroups[0].creators[0],
        agencyLabel: allAgencyGroups[0].agencyLabel,
        regionLabel: allAgencyGroups[0].regions[0].regionLabel,
        subgroupLabel: allAgencyGroups[0].regions[0].subgroups[0].label ?? undefined,
      }
    : null
  const displayedPlacement = selectedPlacement ?? fallbackPlacement
  const hasResults = agencyGroups.length > 0

  return (
    <ConfigProvider
      theme={{
        token: { colorPrimary: theme.primary },
        components: {
          Segmented: {
            itemColor: "var(--main-oshi-text-secondary)",
            itemHoverColor: "var(--main-oshi-text-primary)",
            itemSelectedColor: "var(--main-oshi-text-primary)",
            itemHoverBg: "color-mix(in srgb, var(--main-oshi-text-primary) 6%, transparent)",
            itemSelectedBg: "transparent",
            trackBg: "transparent",
            trackPadding: 0,
          },
        },
      }}
    >
      <div className="my-oshi-select">
        <div className="my-oshi-select__header">
          <div>
            <p className="my-oshi-select__eyebrow">{t(locale, "myOshiSettings.statusMarker")}</p>
            <h1 className="my-oshi-select__title">{t(locale, "myOshiSettings.pageTitle")}</h1>
          </div>
          <Input
            className="my-oshi-select__search"
            placeholder={t(locale, "oshiSettings.searchPlaceholder")}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            prefix={<Search size={15} aria-hidden="true" />}
            allowClear
          />
        </div>

        <div className="my-oshi-select__layout">
          <div className="my-oshi-select__roster" aria-label={t(locale, "myOshiSettings.rosterAria")}>
            {!hasResults && <p className="my-oshi-select__empty-state">{t(locale, "oshiSettings.noResults")}</p>}

            {agencyGroups.map((agency) =>
              agency.regions.map((region) => (
                <section key={`${agency.agencyLabel}-${region.branch}`} className="my-oshi-select__region">
                  <div className="my-oshi-select__region-header">
                    <h2 className="my-oshi-select__region-title">
                      {formatRegionHeading(agency.agencyLabel, region.regionLabel)}
                    </h2>
                  </div>
                  {region.subgroups.map((subgroup) => (
                    <div key={subgroup.label ?? "__flat__"} className="my-oshi-select__subgroup">
                      {subgroup.label && (
                        <h3 className="my-oshi-select__subgroup-title">{subgroupTitle(locale, subgroup.label)}</h3>
                      )}
                      <Segmented<string>
                        classNames={{
                          root: "my-oshi-select__segmented",
                          item: "my-oshi-select__segment-item",
                          label: "my-oshi-select__segment-label",
                        }}
                        value={defaultOshiId}
                        onChange={setDefaultOshiId}
                        options={subgroup.creators.map((creator) => ({
                          value: creator.channelId,
                          label: <CreatorSegmentLabel creator={creator} />,
                        }))}
                      />
                    </div>
                  ))}
                </section>
              )),
            )}
          </div>

          {displayedPlacement && <SelectedCreatorPanel placement={displayedPlacement} locale={locale} />}
        </div>
      </div>
    </ConfigProvider>
  )
}
