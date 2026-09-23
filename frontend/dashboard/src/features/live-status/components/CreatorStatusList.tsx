import { Avatar } from "antd"
import { Heart } from "lucide-react"
import { Fragment, useState, type CSSProperties } from "react"
import { mockCreators, type MockCreator } from "../../../entities/creator/data/mockCreators"
import { useSelectedCreator } from "../../oshi/hooks/useSelectedCreator"
import { useSwipeToFavorite } from "../../favorites/hooks/useSwipeToFavorite"
import { creatorMatchesSearch, groupCreatorsForDockWithSubgroups } from "../../../entities/creator/utils/dockCreatorOrder"
import { formatCreatorStatus, type UpcomingDisplayMode } from "../model/creatorStatusFormat"
import type { CountdownLanguage } from "../../../shared/i18n/model/countdownLanguage"
import { GAMERS_GROUP_LABEL_KEY, OTHER_GROUP_LABEL_KEY } from "../../../entities/creator/utils/hololiveSubgrouping"
import { getMemberAccent } from "../../../shared/theme/memberAccent"
import { type BranchKey } from "../../../entities/creator/model/domain"
import type { CreatorStatus } from "../model/creatorStatus"
import { t, type Locale } from "../../../shared/i18n/translations"
import { OshiSwitchConfirmDialog } from "../../oshi/components/OshiSwitchConfirmDialog"

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
type CreatorNameAccentStyle = CSSProperties & { "--member-theme-color": string }

/** Per-row hover/focus accent for the creator's OWN name -- independent of
 * currentOshi (creatorThemeStyle's --creator-main), which stays bound to
 * whichever creator is actually selected, not whichever row the pointer
 * happens to be over. */
function creatorNameAccentStyle(creator: MockCreator): CreatorNameAccentStyle {
  return { "--member-theme-color": getMemberAccent(creator.channelId, creator.themeColor).primary }
}

function CreatorAvatar({ creator, isFavorite }: { creator: MockCreator; isFavorite: boolean }) {
  const accent = getMemberAccent(creator.channelId, creator.themeColor)
  const spokenName = creator.channelName.replace(/\n/g, " ")

  return (
    <span className="live-status-member__avatar-wrap">
      <Avatar
        size={36}
        src={creator.avatarUrl}
        alt={spokenName}
        className="live-status-member__avatar"
        style={creator.avatarUrl ? undefined : { background: accent.primary, color: accent.textAccent }}
      >
        {creator.channelName.charAt(0)}
      </Avatar>
      {isFavorite && (
        <Heart className="live-status-member__favorite-indicator" aria-hidden="true" fill="currentColor" />
      )}
    </span>
  )
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
 * row's). Swiping slides the row itself above a static reveal layer behind
 * it; committing calls the SAME shared `onToggleFavorite` the row's favorite
 * heart already reads from.
 *
 * The row's second line is the creator's current or upcoming stream topic —
 * CreatorStatus.title, the same field the status label already comes from —
 * never their agency/branch, which the group heading above already states. */
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
  const topic = status.kind === "offline" ? null : status.title

  return (
    <div className="live-status-member-swipe">
      {swipe.revealSide && (
        <div
          className={`live-status-member__reveal live-status-member__reveal--${swipe.revealSide}`}
          style={{ opacity: swipe.revealOpacity }}
          aria-hidden="true"
        >
          {swipe.revealSide === "left" ? t(locale, "favorite.add") : t(locale, "favorite.remove")}
        </div>
      )}
      <div
        className={`live-status-member${swipe.isSnapping ? " live-status-member--snapping" : ""}`}
        data-main-oshi={isActive}
        style={{ transform: `translateX(${swipe.translateX}px)` }}
        {...swipe.rowHandlers}
      >
        <button
          type="button"
          className="live-status-member__creator-button"
          style={creatorNameAccentStyle(creator)}
          onClick={swipe.guardClick(() => onCreatorButtonClick(creator))}
          aria-label={t(locale, "creatorStatusList.switchOshiTo", { creatorName: creator.channelName })}
        >
          <CreatorAvatar creator={creator} isFavorite={isFavorite} />
          <span className="live-status-member__main">
            <span className="live-status-member__name-row">
              <span className="live-status-member__name">{creator.channelName}</span>
              {isActive && <span className="live-status-member__main-badge">{t(locale, "creatorStatusList.mainBadge")}</span>}
            </span>
            {topic && <span className="live-status-member__topic">{topic}</span>}
          </span>
        </button>
        <button
          type="button"
          className="live-status-member__status"
          data-status={status.kind}
          disabled={!display.clickable}
          onClick={swipe.guardClick(() => {
            if (status.kind === "live" || status.kind === "upcoming") {
              onSelectVideo({ videoId: status.videoId, title: status.title })
            }
          })}
        >
          {display.label}
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

/** An unset `favoriteOnlyIds` means the "all" view -- every creator matches. */
function matchesFavoriteFilter(channelId: string, favoriteOnlyIds: Set<string> | undefined): boolean {
  return !favoriteOnlyIds || favoriteOnlyIds.has(channelId)
}

/** The grouped, searchable creator status list — the Live Status drawer's
 * own content, kept as its own component so the list/search-filter/status/
 * favorite logic lives in one place rather than being duplicated by any
 * future second host. */
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
  // The shared active-Oshi selection (Home + drawer both already read/write
  // this same store) -- read-only here, purely to compare against each row's
  // own channelId for the MAIN treatment (spec: "reuse the existing shared
  // selected-Oshi state, do NOT create a second local selected state").
  const [activeOshiId] = useSelectedCreator()

  function handleCreatorClick(creator: MockCreator) {
    if (confirmOshiSwitch) {
      setPendingSwitch({ channelId: creator.channelId, channelName: creator.channelName })
    } else {
      onSelectCreator(creator.channelId)
    }
  }

  return (
    <div className="live-status-roster">
      {groups.map((group) => {
        // Trivially derived from the same `statuses` already passed into
        // this component -- no new data source/backend query (spec: "Live
        // count per group may be shown only if it is trivially derived
        // from already available state").
        const liveChannelIds = new Set(
          group.subgroups.flatMap((subgroup) => subgroup.creators.map((creator) => creator.channelId)),
        )
        const liveCount = [...liveChannelIds].filter((channelId) => statuses[channelId]?.kind === "live").length
        return (
          <div key={group.branch} className="live-status-group">
            <div className="live-status-group__heading">
              <span>{formatBranchHeading(group.branch)}</span>
              {liveCount > 0 && (
                <span className="live-status-group__live-count">
                  <span className="live-status-group__live-dot" aria-hidden="true" />
                  {String(liveCount).padStart(2, "0")} LIVE
                </span>
              )}
            </div>
            {group.subgroups.map((subgroup) => (
              <Fragment key={subgroup.label ?? "__flat__"}>
                {subgroup.label && (
                  <div className="live-status-group__subheading">{subgroupTitle(locale, subgroup.label)}</div>
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
        <div className="oshi-empty-state">
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
 * only). */
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
