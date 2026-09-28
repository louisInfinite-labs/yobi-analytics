import { useState, type CSSProperties } from "react"
import { Avatar, ConfigProvider, Input, Segmented } from "antd"
import { Crosshair, Search } from "lucide-react"
import { resolveCreatorKey, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import type { CanonicalCreator } from "../../../entities/creator/model/creatorMaster"
import { useDefaultOshiCreator } from "../hooks/useDefaultOshiCreator"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t, type Locale } from "../../../shared/i18n/translations"
import {
  GAMERS_GROUP_LABEL_KEY,
  groupSelectableCreatorsForMyOshi,
  OTHER_GROUP_LABEL_KEY,
  type MyOshiAgencyGroup,
} from "../utils/myOshiCanonicalRoster"
import { getMemberAccent } from "../../../shared/theme/memberAccent"
import { useMemberTheme } from "../../../shared/theme/ThemeContext"

type CreatorAccentStyle = CSSProperties & {
  "--creator-accent": string
  "--creator-accent-soft": string
  "--creator-accent-text": string
}

interface SelectedCreatorPlacement {
  creator: CanonicalCreator
  agencyLabel: string
  regionLabel: string
  subgroupLabel?: string
}

/** Same sentinel-label swap as OshiSettings.tsx's own subgroupTitle --
 * both pages group via the same shared subgroupsForBranch algorithm (this
 * page through myOshiCanonicalRoster.ts, OshiSettings.tsx still through
 * oshiSettingsGrouping.ts), so the same two sentinel keys apply. */
function subgroupTitle(locale: Locale, label: string): string {
  if (label === OTHER_GROUP_LABEL_KEY) return t(locale, "oshiSettings.otherGroupLabel")
  if (label === GAMERS_GROUP_LABEL_KEY) return t(locale, "oshiSettings.gamersGroupLabel")
  return label
}

/** Seeded with the legacy "ch_"-form id (not creatorId) so a creator's
 * hashed-palette fallback accent (no verified themeColor) stays pixel-
 * identical to before this migration -- same hash input as when this page
 * read MockCreator.channelId directly. */
function creatorAccentStyle(creator: CanonicalCreator): CreatorAccentStyle {
  const accent = getMemberAccent(toLegacyRosterId(creator), creator.themeColor)
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
  agencyGroups: MyOshiAgencyGroup[],
  creatorId: string | undefined,
): SelectedCreatorPlacement | null {
  if (!creatorId) return null
  for (const agency of agencyGroups) {
    for (const region of agency.regions) {
      for (const subgroup of region.subgroups) {
        const creator = subgroup.creators.find((candidate) => candidate.creatorId === creatorId)
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

function CreatorAvatar({ creator, variant }: { creator: CanonicalCreator; variant: "slot" | "hero" }) {
  const spokenName = creator.displayName.replace(/\n/g, " ")

  return (
    <Avatar
      className={`my-oshi-select__avatar my-oshi-select__avatar--${variant}`}
      src={creator.avatarUrl ?? undefined}
      alt={creator.avatarUrl ? spokenName : undefined}
    >
      {creator.displayName.charAt(0)}
    </Avatar>
  )
}

function CreatorSegmentLabel({ creator }: { creator: CanonicalCreator }) {
  return (
    <span className="my-oshi-select__slot" style={creatorAccentStyle(creator)}>
      <span className="my-oshi-select__slot-avatar-frame">
        <CreatorAvatar creator={creator} variant="slot" />
      </span>
      <span className="my-oshi-select__slot-name">{creator.displayName}</span>
    </span>
  )
}

function SelectedCreatorPanel({ placement, locale }: { placement: SelectedCreatorPlacement; locale: Locale }) {
  const groupLabel = placement.subgroupLabel ? subgroupTitle(locale, placement.subgroupLabel) : null

  return (
    <aside
      className="my-oshi-select__presentation"
      style={creatorAccentStyle(placement.creator)}
      aria-label={t(locale, "myOshiSettings.presentationAria", { name: placement.creator.displayName.replace(/\n/g, " ") })}
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
        <h2 className="my-oshi-select__selected-name">{placement.creator.displayName}</h2>
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

  const allAgencyGroups = groupSelectableCreatorsForMyOshi("")
  const agencyGroups = groupSelectableCreatorsForMyOshi(searchQuery)
  const selectedCanonicalId = resolveCreatorKey(defaultOshiId)?.creatorId
  const selectedPlacement = findSelectedCreatorPlacement(allAgencyGroups, selectedCanonicalId)
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
        <header className="my-oshi-select__header settings-page-header settings-page-header--with-meta">
          <div className="settings-page-header-copy">
            <h1 className="settings-page-title">{t(locale, "myOshiSettings.pageTitle")}</h1>
            <p className="settings-page-description">{t(locale, "myOshiSettings.pageDescription")}</p>
          </div>
          <Input
            className="my-oshi-select__search"
            placeholder={t(locale, "oshiSettings.searchPlaceholder")}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            prefix={<Search size={15} aria-hidden="true" />}
            allowClear
          />
        </header>

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
                          value: toLegacyRosterId(creator),
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
