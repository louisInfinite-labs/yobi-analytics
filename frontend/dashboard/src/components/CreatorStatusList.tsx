import { useState } from "react"
import { mockCreators, type MockCreator } from "../data/mockCreators"
import { useSwipeToFavorite } from "../hooks/useSwipeToFavorite"
import { creatorMatchesSearch, groupCreatorsForDock } from "../lib/dockCreatorOrder"
import { formatCreatorStatus, type CountdownLanguage, type UpcomingDisplayMode } from "../lib/creatorStatusFormat"
import { getMemberAccent } from "../theme/memberAccent"
import { BRANCH_LABELS } from "../types/domain"
import type { CreatorStatus } from "../types/creatorStatus"
import { t, type Locale } from "../i18n/translations"
import { OshiSwitchConfirmDialog } from "./OshiSwitchConfirmDialog"

/** Avatar + favorite indicator, factored out so the image-load-failure
 * state (spec: "the existing colored-circle/initial placeholder may remain
 * ONLY as fallback") lives per-row rather than in the list's own state —
 * same onError->placeholder pattern HomePage's RoomLayer already uses for
 * the room-scene layers. */
function CreatorAvatar({ creator, isFavorite }: { creator: MockCreator; isFavorite: boolean }) {
  const [imageFailed, setImageFailed] = useState(false)
  const accent = getMemberAccent(creator.channelId)
  const showImage = Boolean(creator.avatarUrl) && !imageFailed

  return (
    <span
      className="creator-status-list__avatar"
      aria-hidden="true"
      style={showImage ? undefined : { background: accent.primary, color: accent.textAccent }}
    >
      {showImage ? (
        <img
          className="creator-status-list__avatar-image"
          src={creator.avatarUrl}
          alt=""
          onError={() => setImageFailed(true)}
        />
      ) : (
        creator.channelName.charAt(0)
      )}
      {isFavorite && (
        <svg className="creator-status-list__favorite-indicator" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 21s-6.72-4.35-9.43-8.36C.68 9.94 1.45 6.28 4.88 4.86A5.5 5.5 0 0 1 12 7.2a5.5 5.5 0 0 1 7.89-2.34c3.43 1.42 4.2 5.08 1.54 7.78C18.72 16.65 12 21 12 21z" />
        </svg>
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
 * store) — no separate/local favorite state is introduced here. */
function CreatorRow({
  creator,
  status,
  displayMode,
  language,
  now,
  isFavorite,
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
        className={`creator-status-list__row${swipe.isSnapping ? " creator-status-list__row--snapping" : ""}`}
        style={{ transform: `translateX(${swipe.translateX}px)` }}
        {...swipe.rowHandlers}
      >
        <button
          type="button"
          className="creator-status-list__creator-button"
          onClick={swipe.guardClick(() => onCreatorButtonClick(creator))}
          aria-label={t(locale, "creatorStatusList.switchOshiTo", { creatorName: creator.channelName })}
        >
          <CreatorAvatar creator={creator} isFavorite={isFavorite} />
          <span className="creator-status-list__row-name">{creator.channelName}</span>
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
          <span className={`creator-status-list__dot creator-status-list__dot--${display.dotColor}`} aria-hidden="true" />
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
  /** "我的收藏": when set, only creators in this set are listed at all — a
   * stricter filter than search, applied first. Omit to list every creator
   * (the "all" mode). */
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
  const groups = groupCreatorsForDock(
    mockCreators.filter((creator) => matchesFavoriteFilter(creator.channelId, favoriteOnlyIds) && creatorMatchesSearch(creator, query)),
  )
  const [pendingSwitch, setPendingSwitch] = useState<{ channelId: string; channelName: string } | null>(null)

  function handleCreatorClick(creator: MockCreator) {
    if (confirmOshiSwitch) {
      setPendingSwitch({ channelId: creator.channelId, channelName: creator.channelName })
    } else {
      onSelectCreator(creator.channelId)
    }
  }

  return (
    <div className="creator-status-list">
      {groups.map((group) => (
        <div key={group.branch} className="creator-status-list__group">
          <div className="creator-status-list__group-label">{BRANCH_LABELS[group.branch]}</div>
          {group.creators.map((creator) => {
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
                locale={locale}
                onCreatorButtonClick={handleCreatorClick}
                onSelectVideo={onSelectVideo}
                onToggleFavorite={onToggleFavorite}
              />
            )
          })}
        </div>
      ))}
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

/** Live/offline counts across the given creator subset (all, or "我的收藏"
 * only) — the "ListStatus" collapsed summary's own numbers (this session:
 * "預設ListStatus係唔打開 只顯示直播數 同OFF數"). */
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
