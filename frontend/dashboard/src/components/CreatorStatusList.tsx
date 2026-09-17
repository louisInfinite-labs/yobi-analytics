import { Avatar } from "antd"
import { Heart } from "lucide-react"
import { Fragment, useState } from "react"
import { mockCreators, type MockCreator } from "../data/mockCreators"
import { useSelectedCreator } from "../hooks/useSelectedCreator"
import { useSwipeToFavorite } from "../hooks/useSwipeToFavorite"
import { creatorMatchesSearch, groupCreatorsForDockWithSubgroups } from "../lib/dockCreatorOrder"
import { formatCreatorStatus, type CountdownLanguage, type UpcomingDisplayMode } from "../lib/creatorStatusFormat"
import { GAMERS_GROUP_LABEL_KEY, OTHER_GROUP_LABEL_KEY } from "../lib/hololiveSubgrouping"
import { getMemberAccent } from "../theme/memberAccent"
import { type BranchKey } from "../types/domain"
import type { CreatorStatus } from "../types/creatorStatus"
import { t, type Locale } from "../i18n/translations"
import { OshiSwitchConfirmDialog } from "./OshiSwitchConfirmDialog"

/** Every subgroup label is a real, locale-independent generation/unit name
 * (e.g. "1期生", "FLOW GLOW") EXCEPT the two sentinel keys below -- same
 * pattern as OshiSettings'/NotificationSettings' own subgroupTitle. */
function subgroupTitle(locale: Locale, label: string): string {
  if (label === OTHER_GROUP_LABEL_KEY) return t(locale, "creatorStatusList.otherGroupLabel")
  if (label === GAMERS_GROUP_LABEL_KEY) return t(locale, "creatorStatusList.gamersGroupLabel")
  return label
}

/** "VSPO! // JP" / "HOLOLIVE // EN" -- same agency-exclamation + "//" region
 * convention Favorites/Oshi Settings already use (formatRegionHeading in
 * MyOshiSettings.tsx/OshiSettings.tsx), applied to this list's own existing
 * BranchKey grouping. This only reformats the heading TEXT -- BRANCH_LABELS
 * and the BranchKey grouping itself (which creators belong to which branch)
 * are completely untouched, so no new grouping rule is introduced. */
function formatBranchHeading(branch: BranchKey): string {
  const org = branch.startsWith("vspo") ? "VSPO!" : "HOLOLIVE"
  const region = branch.endsWith("_jp") ? "JP" : branch.endsWith("_en") ? "EN" : "ID"
  return `${org} // ${region}`
}

/** Avatar + favorite indicator. antd's own Avatar already falls back to its
 * `children` whenever `src` is unset or fails to load (see antd's Avatar.js
 * -- isImgExist state, no onError needed for that), so this needs no
 * separate image-load-failure state of its own any more -- confirmed real
 * YouTube avatar URLs are NOT currently exposed anywhere in this app's data
 * (mockCreators.ts's own avatarUrl field is left unset on every entry, per
 * its own doc comment); this stays avatar-ready for the moment a real URL
 * source exists, without inventing one. */
function CreatorAvatar({
  creator,
  isFavorite,
  isActive,
}: {
  creator: MockCreator
  isFavorite: boolean
  isActive: boolean
}) {
  const accent = getMemberAccent(creator.channelId)
  const spokenName = creator.channelName.replace(/\n/g, " ")

  return (
    <span className="creator-status-list__avatar-wrap">
      <Avatar
        size={48}
        src={creator.avatarUrl}
        alt={spokenName}
        className={`creator-status-list__avatar${isActive ? " creator-status-list__avatar--active" : ""}`}
        style={creator.avatarUrl ? undefined : { background: accent.primary, color: accent.textAccent }}
      >
        {creator.channelName.charAt(0)}
      </Avatar>
      {isFavorite && (
        <Heart className="creator-status-list__favorite-indicator" aria-hidden="true" fill="currentColor" />
      )}
    </span>
  )
}

/** The status marker -- kind-driven (not display.dotColor, which is "red"
 * for BOTH live and upcoming per formatCreatorStatus's own existing
 * classification, unchanged here): a solid pulsing dot for LIVE, a static
 * outlined diamond for Upcoming, nothing for Offline (spec: "no
 * attention-grabbing status dot"). Purely a presentation choice layered on
 * top of the existing status.kind -- the underlying classification/label/
 * clickability logic in creatorStatusFormat.ts is untouched. */
function StatusMarker({ kind }: { kind: CreatorStatus["kind"] }) {
  if (kind === "live") return <span className="creator-status-list__status-marker creator-status-list__status-marker--live" aria-hidden="true" />
  if (kind === "upcoming") return <span className="creator-status-list__status-marker creator-status-list__status-marker--upcoming" aria-hidden="true" />
  return null
}

interface CreatorRowProps {
  creator: MockCreator
  status: CreatorStatus
  displayMode: UpcomingDisplayMode
  language: CountdownLanguage
  now: Date
  isFavorite: boolean
  isActive: boolean
  locale: Locale
  onCreatorButtonClick: (creator: MockCreator) => void
  onSelectVideo: (video: { videoId: string; title: string }) => void
  onToggleFavorite: (channelId: string) => void
}

/** One creator row, plus its own swipe-to-favorite gesture (useSwipeToFavorite
 * is called once per row here — hooks can't be called inside the list's own
 * .map(), and each row's drag state must be independent of every other
 * row's). Swiping slides `.creator-status-list__row` itself above a static
 * reveal layer behind it; committing calls the SAME shared `onToggleFavorite`
 * the row's favorite heart already reads from (Task 1's shared favorites
 * store) — no separate/local favorite state is introduced here.
 *
 * "Main Oshi" here reuses the exact same existing signal this component
 * already had (isActive, from useSelectedCreator -- see this file's own
 * prior "CURRENT ACTIVE OSHI only" comment) -- no new data source, just a
 * stronger visual treatment (left rail + ring + "MAIN" label) than before,
 * per the redesign's own "Main Oshi > Favorite" priority. */
function CreatorRow({
  creator,
  status,
  displayMode,
  language,
  now,
  isFavorite,
  isActive,
  locale,
  onCreatorButtonClick,
  onSelectVideo,
  onToggleFavorite,
}: CreatorRowProps) {
  const display = formatCreatorStatus(status, displayMode, now, language)
  const swipe = useSwipeToFavorite(isFavorite, () => onToggleFavorite(creator.channelId))

  return (
    <div className="creator-status-list__swipe-row">
      {swipe.revealSide && (
        <div
          className={`creator-status-list__reveal creator-status-list__reveal--${swipe.revealSide}`}
          style={{ opacity: swipe.revealOpacity }}
          aria-hidden="true"
        >
          {swipe.revealSide === "left" ? t(locale, "favorite.add") : t(locale, "favorite.remove")}
        </div>
      )}
      <div
        className={`creator-status-list__row${isActive ? " creator-status-list__row--main" : ""}${swipe.isSnapping ? " creator-status-list__row--snapping" : ""}`}
        style={{ transform: `translateX(${swipe.translateX}px)` }}
        {...swipe.rowHandlers}
      >
        {isActive && <span className="creator-status-list__main-rail" aria-hidden="true" />}
        <button
          type="button"
          className="creator-status-list__creator-button"
          onClick={swipe.guardClick(() => onCreatorButtonClick(creator))}
          aria-label={t(locale, "creatorStatusList.switchOshiTo", { creatorName: creator.channelName })}
        >
          <CreatorAvatar creator={creator} isFavorite={isFavorite} isActive={isActive} />
          <span className="creator-status-list__row-name">{creator.channelName}</span>
          {isActive && <span className="creator-status-list__main-label">MAIN</span>}
        </button>
        <button
          type="button"
          className="creator-status-list__status-button"
          disabled={!display.clickable}
          onClick={swipe.guardClick(() => {
            if (status.kind === "live" || status.kind === "upcoming") {
              onSelectVideo({ videoId: status.videoId, title: status.title })
            }
          })}
        >
          <StatusMarker kind={status.kind} />
          <span className="creator-status-list__status-label">{display.label}</span>
        </button>
      </div>
    </div>
  )
}

export interface CreatorStatusListProps {
  statuses: Record<string, CreatorStatus>
  now: Date
  displayMode: UpcomingDisplayMode
  language: CountdownLanguage
  /** Search text already typed by the caller — this component only filters/renders, the search input itself is the caller's own UI. */
  query: string
  onSelectVideo: (video: { videoId: string; title: string }) => void
  /** Avatar+name click (spec: "switches the active Oshi") — never opens
   * YouTube and never touches favorite state. */
  onSelectCreator: (channelId: string) => void
  /** Favorites-only filter: when set, only creators in this set are listed
   * at all — a stricter filter than search, applied first. Omit to list
   * every creator (the "all" mode). */
  favoriteOnlyIds?: Set<string>
  favorites: Set<string>
  /** Committed by each row's own swipe-to-favorite gesture (CreatorRow /
   * useSwipeToFavorite) on release past the ±72px threshold — there is
   * still no separate favorite column/permanent button, per spec's "Do NOT
   * add a separate favorite column / permanent favorite button". Calls
   * straight through to the shared favorites store (Task 1), so every
   * mounted consumer's heart/counts/favorites-view updates immediately. */
  onToggleFavorite: (channelId: string) => void
  /** Locale for this list's own newly added user-facing text (the
   * Oshi-switch confirmation dialog, and each row's swipe-reveal label) —
   * see useLocale. */
  locale: Locale
  /** Global "ask before switching Oshi" preference and its setter (see
   * useConfirmOshiSwitchPreference) — not tied to any one creator. */
  confirmOshiSwitch: boolean
  onConfirmOshiSwitchChange: (next: boolean) => void
}

function matchesFavoriteFilter(channelId: string, favoriteOnlyIds: Set<string> | undefined): boolean {
  return !favoriteOnlyIds || favoriteOnlyIds.has(channelId)
}

/** The grouped, searchable creator status list — the Dock's own content,
 * factored out so both the global bottom-right Dock and Home's inline
 * "ListStatus" panel render the exact same list/search-filter/status/
 * favorite logic instead of two copies (this session's own "don't create
 * separate Home and Dock status logic" principle, extended from the
 * formatter to the list rendering itself). */
export function CreatorStatusList({
  statuses,
  now,
  displayMode,
  language,
  query,
  onSelectVideo,
  onSelectCreator,
  favoriteOnlyIds,
  favorites,
  onToggleFavorite,
  locale,
  confirmOshiSwitch,
  onConfirmOshiSwitchChange,
}: CreatorStatusListProps) {
  const groups = groupCreatorsForDockWithSubgroups(
    mockCreators.filter((creator) => matchesFavoriteFilter(creator.channelId, favoriteOnlyIds) && creatorMatchesSearch(creator, query)),
  )
  const [pendingSwitch, setPendingSwitch] = useState<{ channelId: string; channelName: string } | null>(null)
  // The shared active-Oshi selection (Home + Dock both already read/write
  // this same store) -- read-only here, purely to compare against each row's
  // own channelId for the selected-avatar glow (spec: "reuse the existing
  // shared selected-Oshi state, do NOT create a second local selected state").
  const [activeOshiId] = useSelectedCreator()

  function handleCreatorClick(creator: MockCreator) {
    if (confirmOshiSwitch) {
      setPendingSwitch({ channelId: creator.channelId, channelName: creator.channelName })
    } else {
      onSelectCreator(creator.channelId)
    }
  }

  return (
    <div className="creator-status-list">
      {groups.map((group) => {
        // Trivially derived from the same `statuses` already passed into
        // this component -- no new data source/backend query (spec: "Live
        // count per group may be shown only if it is trivially derived
        // from already available state").
        const liveCount = group.subgroups.reduce(
          (count, subgroup) => count + subgroup.creators.filter((creator) => statuses[creator.channelId]?.kind === "live").length,
          0,
        )
        return (
          <div key={group.branch} className="creator-status-list__group">
            <div className="creator-status-list__group-header">
              <span className="creator-status-list__group-label">{formatBranchHeading(group.branch)}</span>
              {liveCount > 0 && (
                <span className="creator-status-list__group-live-count">
                  <span className="creator-status-list__group-live-dot" aria-hidden="true" />
                  {String(liveCount).padStart(2, "0")} LIVE
                </span>
              )}
            </div>
            {group.subgroups.map((subgroup) => (
              <Fragment key={subgroup.label ?? "__flat__"}>
                {subgroup.label && (
                  <div className="creator-status-list__subgroup-label">{subgroupTitle(locale, subgroup.label)}</div>
                )}
                {subgroup.creators.map((creator) => {
                  const status = statuses[creator.channelId] ?? { kind: "offline" as const }
                  const isFavorite = favorites.has(creator.channelId)
                  return (
                    <CreatorRow
                      key={creator.channelId}
                      creator={creator}
                      status={status}
                      displayMode={displayMode}
                      language={language}
                      now={now}
                      isFavorite={isFavorite}
                      isActive={creator.channelId === activeOshiId}
                      locale={locale}
                      onCreatorButtonClick={handleCreatorClick}
                      onSelectVideo={onSelectVideo}
                      onToggleFavorite={onToggleFavorite}
                    />
                  )
                })}
              </Fragment>
            ))}
          </div>
        )
      })}
      {groups.length === 0 && (
        <div className="creator-status-list__empty">
          {favoriteOnlyIds ? t(locale, "creatorStatusList.emptyFavorites") : t(locale, "creatorStatusList.emptySearch")}
        </div>
      )}
      {pendingSwitch && (
        <OshiSwitchConfirmDialog
          creatorName={pendingSwitch.channelName}
          locale={locale}
          onCancel={() => setPendingSwitch(null)}
          onConfirm={(dontAskAgain) => {
            onSelectCreator(pendingSwitch.channelId)
            if (dontAskAgain) onConfirmOshiSwitchChange(false)
            setPendingSwitch(null)
          }}
        />
      )}
    </div>
  )
}

/** Live/offline counts across the given creator subset (all, or favorites
 * only) — the "ListStatus" collapsed summary's own numbers, shown by
 * default before the list itself is expanded. */
export function countLiveAndOffline(
  statuses: Record<string, CreatorStatus>,
  favoriteOnlyIds?: Set<string>,
): { live: number; offline: number } {
  const values = Object.entries(statuses)
    .filter(([channelId]) => matchesFavoriteFilter(channelId, favoriteOnlyIds))
    .map(([, status]) => status)
  return {
    live: values.filter((s) => s.kind === "live").length,
    offline: values.filter((s) => s.kind === "offline").length,
  }
}
