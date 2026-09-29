import { useState, type CSSProperties } from "react"
import { Checkbox, ConfigProvider, Segmented } from "antd"
import { Heart } from "lucide-react"
import { toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import type { CanonicalCreator } from "../../../entities/creator/model/creatorMaster"
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
 * purpose.
 *
 * Seeded with the legacy "ch_"-form id (toLegacyRosterId), not creatorId, so
 * a creator's hashed-palette fallback accent (no verified themeColor) stays
 * pixel-identical to before this migration (C8B) -- same hash input as when
 * this page read MockCreator.channelId directly. */
function creatorAccentStyle(creator: CanonicalCreator): CreatorAccentStyle {
  const accent = getMemberAccent(toLegacyRosterId(creator), creator.themeColor)
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
function FavoriteTile({ creator }: { creator: CanonicalCreator }) {
  const [locale] = useLocale()
  const { favorites, toggleFavorite } = useFavoriteCreators()
  // Favorites' own persisted key space is the legacy "ch_"-prefixed roster
  // id (mockCreators.channelId), unchanged by C8B -- toLegacyRosterId
  // bridges this page's now-canonical creator objects back to that exact
  // pre-existing format (not byte-equal to creatorId for every creator,
  // e.g. airani_iofifteen -> ch_iofi, not ch_airani_iofifteen).
  const legacyFavoriteId = toLegacyRosterId(creator)
  const isFavorite = favorites.has(legacyFavoriteId)
  // A handful of names carry explicit "\n" line breaks for their on-screen
  // display (see mockCreators.ts) -- collapsed back to spaces here so the
  // checkbox's own aria-label reads as one normal sentence, not literal
  // newlines.
  const spokenName = creator.displayName.replace(/\n/g, " ")
  const accent = getMemberAccent(legacyFavoriteId, creator.themeColor)
  // C7B populated the current production registry with real YouTube avatar
  // thumbnails, but the schema stays nullable (a creator can still lack one)
  // -- this fallback mirrors CreatorStatusList.tsx's own CreatorAvatar
  // pattern rather than assuming avatarUrl is now permanently non-null.
  const [imageFailed, setImageFailed] = useState(false)
  const showImage = Boolean(creator.avatarUrl) && !imageFailed

  return (
    <Checkbox
      className={`favorites-roster__tile${isFavorite ? " favorites-roster__tile--selected" : ""}`}
      style={creatorAccentStyle(creator)}
      checked={isFavorite}
      onChange={() => toggleFavorite(legacyFavoriteId)}
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
              src={creator.avatarUrl ?? undefined}
              alt=""
              onError={() => setImageFailed(true)}
            />
          ) : (
            creator.displayName.charAt(0)
          )}
        </span>
        {isFavorite && <Heart className="favorites-roster__favorite-icon" aria-hidden="true" fill="currentColor" />}
      </span>
      <span className="favorites-roster__name">{creator.displayName}</span>
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
 * Reads the shared canonical Creator Registry (C8B: getCreators(), via
 * groupCreatorsForOshiSettings -- migrated off mockCreators) and its own
 * existing search (creatorMatchesSearch). This page is purely about WHICH
 * creators are favorited -- it has no bearing on which creators Live Status
 * displays at all (a separate, unrelated rule this page never touches).
 * Applies NO eligibility filter of its own (unlike My Oshi's
 * isCurrentMemberEligible) -- every canonical creator, including group/staff
 * channels, remains favoritable, same as before this migration. The one
 * exception: ch_hololive_staff was always mock-only (no Creator Master
 * counterpart) and is therefore no longer renderable here -- an existing
 * persisted favorite for it is left as an orphaned legacy value, never
 * crashed on or silently deleted. */
export function OshiSettings() {
  const [locale] = useLocale()
  const { theme } = useMemberTheme()
  const { favorites } = useFavoriteCreators()
  const [searchQuery, setSearchQuery] = useState("")
  const [viewMode, setViewMode] = useState<ViewMode>("all")

  // The page-level All/Favorites filter reuses groupCreatorsForOshiSettings'
  // own existing optional filterCreator param. This is a client-side VIEW
  // filter only; it never touches favorite state (confirmed with the user:
  // search/filter must never mutate favorites). toLegacyRosterId bridges
  // each canonical creator back to the pre-existing persisted favorite key
  // space (see FavoriteTile's own comment on legacyFavoriteId).
  const agencyGroups = groupCreatorsForOshiSettings(searchQuery, viewMode === "favorites" ? (creator) => favorites.has(toLegacyRosterId(creator)) : undefined)
  const hasResults = agencyGroups.length > 0

  return (
    // Scoped to this component's own subtree only -- Checkbox and Segmented
    // are the only antd controls used here. The Segmented below now gets
    // its actual visual style (background/border/radius/item height/font/
    // colors/hover) from the shared .shared-filter-segmented class,
    // matching Live Reminder Time and Live Status' own All/Favorites
    // toggle 1:1 (confirmed with the user) -- the theme-tinted Segmented
    // tokens just below (incl. this control's own active-member-colored
    // itemSelectedBg) are now superseded by that shared class, not removed
    // outright, in case a future control in this same subtree still wants
    // them. Checkbox itself is unaffected, still themed off colorPrimary.
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
        <header className="favorites-roster__header settings-page-header settings-page-header--with-meta">
          <div className="settings-page-header-copy">
            <h1 className="settings-page-title">{t(locale, "oshiSettings.pageTitle")}</h1>
            <p className="settings-page-description">{t(locale, "oshiSettings.pageDescription")}</p>
          </div>
          <span className="favorites-roster__count">
            {t(locale, "oshiSettings.selectedCountLabel", { count: String(favorites.size) })}
          </span>
        </header>

        <div className="favorites-roster__controls">
          <Segmented
            classNames={{ root: "favorites-roster__segmented shared-filter-segmented" }}
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
              const regionSelectedCount = regionCreators.filter((creator) => favorites.has(toLegacyRosterId(creator))).length
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
                          <FavoriteTile key={creator.creatorId} creator={creator} />
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
