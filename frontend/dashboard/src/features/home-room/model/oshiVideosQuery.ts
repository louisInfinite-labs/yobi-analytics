import type { VideoSortOption } from "../utils/recentVideosSelection"
import { isSpecialVideoFilter, type SpecialVideoFilter, type VideoSectionSelection } from "./specialVideoFilters"

/** Home's Oshi Videos shelf query. It is ALWAYS one creator's own content:
 * `creatorId` is the current Home Oshi's canonical creatorId, and the backend
 * applies creator -> topic -> contentType -> sort/ranking -> limit in that
 * order over that creator's whole persisted catalog. Nothing here ever
 * aggregates across creators. */
/** The backend's canonical content types: the UI shows "upload" as 影片 / Videos (label only). */
export type VideoContentType = "all" | "live" | "upload"
/** "total" = lifetime views; 1d/7d/30d = absolute view growth over that window.
 * Only meaningful when the sort is "mostViews". */
export type VideoViewWindow = "total" | "1d" | "7d" | "30d"

export const VIDEO_CONTENT_TYPES: readonly VideoContentType[] = ["all", "live", "upload"]
export const VIDEO_VIEW_WINDOWS: readonly VideoViewWindow[] = ["total", "1d", "7d", "30d"]

export interface OshiVideosQuery {
  creatorId: string
  /** A backend topic id as GET /topics returned it, or "all" -- never a
   * closed frontend union (see model/videoTopicCatalog.ts). */
  topic: string
  contentType: VideoContentType
  sort: VideoSortOption
  viewWindow: VideoViewWindow
}

/** The user-adjustable shelf controls (the topic tags' content type / sort / view window). */
export interface OshiVideosControls {
  contentType: VideoContentType
  sort: VideoSortOption
  viewWindow: VideoViewWindow
}

/** The two quick filters are fixed shortcuts over the same archive endpoints, so the user
 * never has to re-pick content type or sort for them:
 *   最新影片 = this creator + topic all + upload + archived + newest
 *   最新直播 = this creator + topic all + live   + archived + newest   (completed archives only,
 *              never the currently-live/upcoming stream -- that is GET /live-streams' job). */
const QUICK_FILTER_CONTROLS: Partial<Record<SpecialVideoFilter, OshiVideosControls>> = {
  latestVideos: { contentType: "upload", sort: "newest", viewWindow: "total" },
  latestLive: { contentType: "live", sort: "newest", viewWindow: "total" },
}

/** True for 最新影片 / 最新直播: their controls are fixed, so the content-type / sort / period dropdowns do not apply. */
export function isQuickFilterSelection(selection: VideoSectionSelection): boolean {
  return isSpecialVideoFilter(selection) && selection in QUICK_FILTER_CONTROLS
}

/** The one place a selected tag (a frontend special filter, or a backend topic id from
 * GET /topics) + the user's controls become a backend query for the CURRENT creator. Null
 * only when the creator has no canonical id (nothing to ask the backend for). */
export function buildShelfQuery(
  selection: VideoSectionSelection,
  creatorId: string | undefined,
  controls: OshiVideosControls,
): OshiVideosQuery | null {
  if (!creatorId) return null
  if (isSpecialVideoFilter(selection)) {
    const quick = QUICK_FILTER_CONTROLS[selection]
    return { creatorId, topic: "all", ...(quick ?? controls) }
  }
  // Any other string is a backend topic id (GET /topics), sent through unchanged.
  return { creatorId, topic: selection, ...controls }
}

/** The window that actually applies: only a "mostViews" sort uses one, so
 * switching to newest/oldest stops applying (and refetching for) the metric. */
export function effectiveViewWindow(sort: VideoSortOption, viewWindow: VideoViewWindow): VideoViewWindow {
  return sort === "mostViews" ? viewWindow : "total"
}

/** Stable identity of what the shelf is showing -- two queries with the same
 * key request the same data, and any difference (a different creator
 * included) is a different shelf. */
export function oshiVideosQueryKey(query: OshiVideosQuery): string {
  return JSON.stringify([query.creatorId, query.topic, query.contentType, query.sort, effectiveViewWindow(query.sort, query.viewWindow)])
}

/** newest/oldest page through GET .../videos/recent; views ranks through
 * GET .../videos/ranking (no offset: one bounded response). */
export const OSHI_VIDEOS_RECENT_PAGE_SIZE = 20
export const OSHI_VIDEOS_RANKING_LIMIT = 100
/** The ranking comes back as one bounded response (up to 100 rows); the shelf reveals it this many cards
 * at a time as the user scrolls, so 100 cards/thumbnails are never rendered at once. */
export const OSHI_VIDEOS_RANKING_REVEAL_BATCH = 20

export interface OshiVideosRequest {
  path: string
  /** True for the offset-paged archive endpoint, false for the one-shot ranking. */
  paged: boolean
}

/** Home's shelf is the archive: plain uploads and COMPLETED livestreams, never the
 * creator's still-upcoming/live-now stream (liveStatus=archived). */
export function buildOshiVideosRequest(query: OshiVideosQuery, offset = 0): OshiVideosRequest {
  const creatorPath = `/creators/${encodeURIComponent(query.creatorId)}/videos`
  const contentType = query.contentType

  if (query.sort === "mostViews") {
    const params = new URLSearchParams({
      metric: effectiveViewWindow(query.sort, query.viewWindow),
      topic: query.topic,
      contentType,
      liveStatus: "archived",
      limit: String(OSHI_VIDEOS_RANKING_LIMIT),
    })
    return { path: `${creatorPath}/ranking?${params}`, paged: false }
  }

  const params = new URLSearchParams({
    topic: query.topic,
    contentType,
    liveStatus: "archived",
    sort: query.sort,
    limit: String(OSHI_VIDEOS_RECENT_PAGE_SIZE),
    offset: String(offset),
  })
  return { path: `${creatorPath}/recent?${params}`, paged: true }
}
