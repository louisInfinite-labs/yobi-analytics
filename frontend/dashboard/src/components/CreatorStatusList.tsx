import { mockCreators } from "../data/mockCreators"
import { creatorMatchesSearch, groupCreatorsForDock } from "../lib/dockCreatorOrder"
import { formatCreatorStatus, type CountdownLanguage, type UpcomingDisplayMode } from "../lib/creatorStatusFormat"
import { BRANCH_LABELS } from "../types/domain"
import type { CreatorStatus } from "../types/creatorStatus"

export interface CreatorStatusListProps {
  statuses: Record<string, CreatorStatus>
  now: Date
  displayMode: UpcomingDisplayMode
  language: CountdownLanguage
  /** Search text already typed by the caller — this component only filters/renders, the search input itself is the caller's own UI. */
  query: string
  onSelectVideo: (video: { videoId: string; title: string }) => void
  /** "我的收藏": when set, only creators in this set are listed at all — a
   * stricter filter than search, applied first. Omit to list every creator
   * (the "all" mode). */
  favoriteOnlyIds?: Set<string>
  favorites: Set<string>
  onToggleFavorite: (channelId: string) => void
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
  favoriteOnlyIds,
  favorites,
  onToggleFavorite,
}: CreatorStatusListProps) {
  const groups = groupCreatorsForDock(
    mockCreators.filter((creator) => matchesFavoriteFilter(creator.channelId, favoriteOnlyIds) && creatorMatchesSearch(creator, query)),
  )

  return (
    <div className="creator-status-list">
      {groups.map((group) => (
        <div key={group.branch} className="creator-status-list__group">
          <div className="creator-status-list__group-label">{BRANCH_LABELS[group.branch]}</div>
          {group.creators.map((creator) => {
            const status = statuses[creator.channelId] ?? { kind: "offline" as const }
            const display = formatCreatorStatus(status, displayMode, now, language)
            const isFavorite = favorites.has(creator.channelId)
            return (
              <div key={creator.channelId} className="creator-status-list__row">
                <button
                  type="button"
                  className={`creator-status-list__favorite-toggle${isFavorite ? " creator-status-list__favorite-toggle--active" : ""}`}
                  onClick={() => onToggleFavorite(creator.channelId)}
                  aria-label={isFavorite ? `Remove ${creator.channelName} from favorites` : `Add ${creator.channelName} to favorites`}
                  aria-pressed={isFavorite}
                >
                  {isFavorite ? "♥" : "♡"}
                </button>
                <button
                  type="button"
                  className="creator-status-list__row-main"
                  disabled={!display.clickable}
                  onClick={() => {
                    if (status.kind === "live" || status.kind === "upcoming") {
                      onSelectVideo({ videoId: status.videoId, title: status.title })
                    }
                  }}
                >
                  <span className="creator-status-list__row-name">{creator.channelName}</span>
                  <span className="creator-status-list__row-status">
                    <span className={`creator-status-list__dot creator-status-list__dot--${display.dotColor}`} aria-hidden="true" />
                    {display.label}
                  </span>
                </button>
              </div>
            )
          })}
        </div>
      ))}
      {groups.length === 0 && (
        <div className="creator-status-list__empty">{favoriteOnlyIds ? "No favorites yet — tap ♡ to add one." : "No matching creator."}</div>
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
