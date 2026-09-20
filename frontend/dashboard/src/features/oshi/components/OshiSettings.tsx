import { useState, type CSSProperties } from "react"
import { Checkbox, ConfigProvider, Segmented } from "antd"
import { Heart } from "lucide-react"
import type { MockCreator } from "../../../entities/creator/data/mockCreators"
import { useFavoriteCreators } from "../../favorites/hooks/useFavoriteCreators"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t, type Locale } from "../../../shared/i18n/translations"
import {
  GAMERS_GROUP_LABEL_KEY,
  groupCreatorsForOshiSettings,
  OTHER_GROUP_LABEL_KEY,
} from "../utils/oshiSettingsGrouping"
import { getMemberAccent } from "../../../shared/theme/memberAccent"
import { useMemberTheme } from "../../../shared/theme/ThemeContext"

/** Every subgroup label is a real, locale-independent group/generation name
 * (e.g. "1期生", "Myth") EXCEPT the two sentinel keys below, each swapped
 * for its own translated wording here -- same sentinel-label pattern as
 * NotificationSettings' own subgroupTitle. */
function subgroupTitle(locale: Locale, label: string): string {
  if (label === OTHER_GROUP_LABEL_KEY) return t(locale, "oshiSettings.otherGroupLabel")
  if (label === GAMERS_GROUP_LABEL_KEY) return t(locale, "oshiSettings.gamersGroupLabel")
  return label
}

type ViewMode = "all" | "favorites"

type CreatorAccentStyle = CSSProperties & {
  "--creator-accent": string
  "--creator-accent-soft": string
  "--creator-accent-text": string
}

/** Same per-creator accent variables, same helper shape, as Oshi Settings'
 * own creatorAccentStyle (MyOshiSettings.tsx) -- confirmed with the user:
 * bring that hover-name-color logic over to this page too. Kept as its own
 * copy rather than importing from a sibling page component (that page's
 * own internal helper, not a shared module) to avoid coupling the two
 * pages together over an implementation detail neither exposes on
 * purpose. */
function creatorAccentStyle(creator: MockCreator): CreatorAccentStyle {
  const accent = getMemberAccent(creator.channelId)
  return {
    "--creator-accent": accent.primary,
    "--creator-accent-soft": accent.soft,
    "--creator-accent-text": accent.textAccent,
  }
}

/** One roster tile: avatar + name + a favorite indicator, all reading/
 * writing the SAME shared favorites store Live Status itself uses
 * (useFavoriteCreators) -- toggling here is immediately visible as Live
 * Status's own favorite heart/favorites-view filter, and vice versa, since
 * both read the identical Set<channelId>. This is a favorite membership
 * toggle, not a Live Status visibility control -- unchecking a creator
 * here never hides them from Live Status.
 *
 * Confirmed with the user: keep the underlying Checkbox/toggleFavorite
 * state semantics, only redesign the VISIBLE UI. This is still a real antd
 * `Checkbox` -- its own default checkbox square is visually hidden (not
 * display:none, so the real nested <input> stays in the tab order and
 * keyboard-operable), and the avatar+name+heart below render as its
 * `children`, which antd already wraps in the SAME <label> as the input.
 * Native <label> behavior alone makes clicking anywhere in the tile toggle
 * the real input -- no extra click handler needed, and Tab/Enter/Space
 * keep working exactly like any other checkbox. */
function FavoriteTile({ creator }: { creator: MockCreator }) {
  const [locale] = useLocale()
  const { favorites, toggleFavorite } = useFavoriteCreators()
  const isFavorite = favorites.has(creator.channelId)
  // A handful of names carry explicit "\n" line breaks for their on-screen
  // display (see mockCreators.ts) -- collapsed back to spaces here so the
  // checkbox's own aria-label reads as one normal sentence, not literal
  // newlines.
  const spokenName = creator.channelName.replace(/\n/g, " ")
  const accent = getMemberAccent(creator.channelId)
  // avatarUrl is never set on any mock creator today (no approved
  // creator-master/YouTube data source exposes it yet -- see
  // mockCreators.ts's own doc comment on the field) -- this stays ready
  // for a real URL the moment one exists, exactly mirroring
  // CreatorStatusList.tsx's own CreatorAvatar fallback pattern, rather
  // than inventing a scraping mechanism or hardcoded image URLs here.
  const [imageFailed, setImageFailed] = useState(false)
  const showImage = Boolean(creator.avatarUrl) && !imageFailed

  return (
    <Checkbox
      className={`favorites-roster__tile${isFavorite ? " favorites-roster__tile--selected" : ""}`}
      style={creatorAccentStyle(creator)}
      checked={isFavorite}
      onChange={() => toggleFavorite(creator.channelId)}
      aria-label={t(locale, isFavorite ? "oshiSettings.removeFavoriteAria" : "oshiSettings.addFavoriteAria", {
        name: spokenName,
      })}
    >
      <span className="favorites-roster__avatar-wrap">
        <span
          className="favorites-roster__avatar"
          aria-hidden="true"
          style={showImage ? undefined : { background: accent.primary, color: accent.textAccent }}
        >
          {showImage ? (
            <img
              className="favorites-roster__avatar-image"
              src={creator.avatarUrl}
              alt=""
              onError={() => setImageFailed(true)}
            />
          ) : (
            creator.channelName.charAt(0)
          )}
        </span>
        {isFavorite && <Heart className="favorites-roster__favorite-icon" aria-hidden="true" fill="currentColor" />}
      </span>
      <span className="favorites-roster__name">{creator.channelName}</span>
    </Checkbox>
  )
}

/** "My Favorites" (收藏名單): an esports roster/squad-management surface,
 * not a grid of settings cards -- confirmed with the user, this is a
 * deliberately different visual language from the sibling MyOshiSettings.tsx
 * ("我推設定", a single-select "choose one Main Oshi" page). The two pages
 * used to share the exact same .oshi-settings__* CSS classes; this page now
 * has its own, entirely separate favorites-roster__* class prefix so
 * MyOshiSettings.tsx (still using .oshi-settings__* verbatim) is completely
 * unaffected by anything below.
 *
 * Reuses Live Status's own roster (mockCreators, via
 * groupCreatorsForOshiSettings -- same creators/IDs/order Live Status
 * itself already groups by) and its own existing search
 * (creatorMatchesSearch). This page is purely about WHICH creators are
 * favorited -- it has no bearing on which creators Live Status displays at
 * all (a separate, unrelated rule this page never touches). */
export function OshiSettings() {
  const [locale] = useLocale()
  const { theme } = useMemberTheme()
  const { favorites } = useFavoriteCreators()
  const [searchQuery, setSearchQuery] = useState("")
  const [viewMode, setViewMode] = useState<ViewMode>("all")

  // The page-level All/Favorites filter reuses groupCreatorsForOshiSettings'
  // own existing optional filterCreator param (already there for
  // MyOshiSettings.tsx's own eligibility filter) -- no new data plumbing,
  // and no change to oshiSettingsGrouping.ts itself. This is a client-side
  // VIEW filter only; it never touches favorite state (confirmed with the
  // user: search/filter must never mutate favorites).
  const agencyGroups = groupCreatorsForOshiSettings(searchQuery, viewMode === "favorites" ? (creator) => favorites.has(creator.channelId) : undefined)
  const hasResults = agencyGroups.length > 0

  return (
    // Scoped to this component's own subtree only -- Checkbox and Segmented
    // are the only antd controls used here, themed off this app's own
    // active member color the same way NotificationSettings' Switch
    // already is. Segmented's own dark styling goes through antd's real,
    // documented component tokens (trackBg/itemColor/itemSelectedBg/...)
    // rather than overriding its internal, version-fragile CSS classes.
    <ConfigProvider
      theme={{
        token: { colorPrimary: theme.primary },
        components: {
          Segmented: {
            trackBg: "var(--roster-surface)",
            itemColor: "var(--roster-text-secondary)",
            itemHoverColor: "var(--roster-text-primary)",
            itemHoverBg: "color-mix(in srgb, var(--roster-text-primary) 8%, transparent)",
            itemSelectedBg: theme.primary,
            itemSelectedColor: "#ffffff",
          },
        },
      }}
    >
      <div className="favorites-roster">
        <div className="favorites-roster__header">
          <h1 className="favorites-roster__title">{t(locale, "oshiSettings.pageTitle")}</h1>
          <span className="favorites-roster__count">
            {t(locale, "oshiSettings.selectedCountLabel", { count: String(favorites.size) })}
          </span>
        </div>

        <div className="favorites-roster__controls">
          <Segmented
            classNames={{ root: "favorites-roster__segmented" }}
            value={viewMode}
            onChange={(value) => setViewMode(value as ViewMode)}
            options={[
              { value: "all", label: t(locale, "recentVideos.tag.all") },
              { value: "favorites", label: t(locale, "oshiSettings.viewFilter.favoritesOnly") },
            ]}
          />
          <input
            type="text"
            className="favorites-roster__search"
            placeholder={t(locale, "oshiSettings.searchPlaceholder")}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>

        {!hasResults && <p className="favorites-roster__empty-state">{t(locale, "oshiSettings.noResults")}</p>}

        {agencyGroups.map((agency) => (
          <section key={agency.agencyLabel} className="favorites-roster__agency">
            {agency.regions.map((region) => {
              const regionCreators = region.subgroups.flatMap((subgroup) => subgroup.creators)
              const regionSelectedCount = regionCreators.filter((creator) => favorites.has(creator.channelId)).length
              return (
                <div key={region.branch} className="favorites-roster__region">
                  <div className="favorites-roster__region-header">
                    {/* agencyLabel/regionLabel are already plain, locale-
                     * agnostic labels ("VSPO"/"Hololive", "JP"/"EN"/"ID")
                     * used directly (not through t()) everywhere else in
                     * the app -- same treatment here. */}
                    <h2 className="favorites-roster__region-title">
                      {agency.agencyLabel} // {region.regionLabel}
                    </h2>
                    <span className="favorites-roster__region-count">
                      {t(locale, "oshiSettings.selectedCountLabel", { count: String(regionSelectedCount) })}
                    </span>
                  </div>
                  {region.subgroups.map((subgroup) => (
                    <div key={subgroup.label ?? "__flat__"} className="favorites-roster__subgroup">
                      {subgroup.label && (
                        <h3 className="favorites-roster__subgroup-title">{subgroupTitle(locale, subgroup.label)}</h3>
                      )}
                      <div className="favorites-roster__grid">
                        {subgroup.creators.map((creator) => (
                          <FavoriteTile key={creator.channelId} creator={creator} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )
            })}
          </section>
        ))}
      </div>
    </ConfigProvider>
  )
}
