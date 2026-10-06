import type { TranslationKey } from "../../../shared/i18n/translations"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

/** The video-section sort dropdown's 3 options (only shown for the "ALL"/
 * backend topic tags, not "latest videos"/"latest live" -- see
 * RecentVideosSection).
 * "newest" is the default, matching the previous hardcoded newest-first
 * behavior every selection function used before this option existed. */
export type VideoSortOption = "newest" | "oldest" | "mostViews"

export const VIDEO_SORT_OPTIONS: readonly VideoSortOption[] = ["newest", "oldest", "mostViews"]

export const VIDEO_SORT_LABEL_KEYS: Record<VideoSortOption, TranslationKey> = {
  newest: "recentVideos.sort.newest",
  oldest: "recentVideos.sort.oldest",
  mostViews: "recentVideos.sort.mostViews",
}

function sortByPublishedDesc(videos: RecentVideo[]): RecentVideo[] {
  return [...videos].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
}

/** The 5 latest normal (non-live) videos, most recent first. No `sort`
 * param -- the sort dropdown only applies to "ALL"/backend topic tags, so
 * this always stays newest-first exactly as before. */
export function selectLatestVideos(videos: RecentVideo[], count = 5): RecentVideo[] {
  return sortByPublishedDesc(videos.filter((v) => v.contentFormat === "normal_video")).slice(0, count)
}

/** The livestream row's 5 slots:
 *  - currently live now → [live now, ...4 most recent completed streams]
 *  - no live now, but an upcoming stream exists → [upcoming, ...4 most recent completed streams]
 *  - otherwise → [5 most recent completed streams]
 * live_now outranks live_upcoming (a creator can't be both), so at most one
 * priority slot is ever prepended either way. Also has no `sort` param, same
 * reason as selectLatestVideos above. */
export function selectLivestreamSlots(videos: RecentVideo[], count = 5): RecentVideo[] {
  const priority = videos.find((v) => v.contentFormat === "live_now") ?? videos.find((v) => v.contentFormat === "live_upcoming")
  const archives = sortByPublishedDesc(videos.filter((v) => v.contentFormat === "live_archive"))

  if (priority) return [priority, ...archives.slice(0, count - 1)]
  return archives.slice(0, count)
}
