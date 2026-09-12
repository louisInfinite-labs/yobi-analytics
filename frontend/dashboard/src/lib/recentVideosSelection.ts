import type { TranslationKey } from "../i18n/translations"
import type { RecentVideo } from "../data/mockRecentVideos"
import type { VideoCategory } from "./videoCategories"

/** The video-section sort dropdown's 3 options (only shown for the "ALL"/
 * 7 category tags, not "latest videos"/"latest live" -- see
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

function sortVideos(videos: RecentVideo[], sort: VideoSortOption): RecentVideo[] {
  if (sort === "oldest") return [...videos].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
  if (sort === "mostViews") return [...videos].sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0))
  return sortByPublishedDesc(videos)
}

/** Merges both pools (latest uploads + streams), deduped by videoId
 * (defensive -- a video shouldn't appear in both pools, but this guards
 * against it rather than assuming it never happens). Backing pool for
 * "ALL" and the 7 game-category tags, which cut across video TYPE
 * (normal_video/live_now/live_archive/shorts) unlike
 * selectLatestVideos/selectLivestreamSlots above, which are each scoped to
 * one type. Not sorted here -- callers sort by the caller-chosen
 * VideoSortOption after merging. */
function mergeAndDedupe(latest: RecentVideo[], streams: RecentVideo[]): RecentVideo[] {
  const seen = new Set<string>()
  const merged: RecentVideo[] = []
  for (const video of [...latest, ...streams]) {
    if (seen.has(video.videoId)) continue
    seen.add(video.videoId)
    merged.push(video)
  }
  return merged
}

/** The video-section tag bar's "ALL" tag: every video from both pools,
 * uncapped by category, ordered by `sort`. */
export function selectAllVideos(latest: RecentVideo[], streams: RecentVideo[], count: number, sort: VideoSortOption = "newest"): RecentVideo[] {
  return sortVideos(mergeAndDedupe(latest, streams), sort).slice(0, count)
}

/** The tag bar's 7 game/topic-category tags (sf6/valo/minecraft/apex/
 * singing/chatting/other) -- a video with no `category` set (e.g. a real
 * Holodex-fetched one, which doesn't derive this field) is treated as
 * "other". */
export function selectVideosByCategory(
  latest: RecentVideo[],
  streams: RecentVideo[],
  category: VideoCategory,
  count: number,
  sort: VideoSortOption = "newest",
): RecentVideo[] {
  return sortVideos(
    mergeAndDedupe(latest, streams).filter((video) => (video.category ?? "other") === category),
    sort,
  ).slice(0, count)
}

/** The 5 latest normal (non-live) videos, most recent first (this session:
 * "最新影片和 最新直播也是5條影片"). */
export function selectLatestVideos(videos: RecentVideo[], count = 5): RecentVideo[] {
  return sortByPublishedDesc(videos.filter((v) => v.contentFormat === "normal_video")).slice(0, count)
}

/** The livestream row's 5 slots:
 *  - currently live now → [live now, ...4 most recent completed streams]
 *  - otherwise → [5 most recent completed streams]
 * (this session's own spec: "如果目前有直播 顯示 現在直播 + 最新直播", slot
 * count later raised to 5 alongside selectLatestVideos). */
export function selectLivestreamSlots(videos: RecentVideo[], count = 5): RecentVideo[] {
  const liveNow = videos.find((v) => v.contentFormat === "live_now")
  const archives = sortByPublishedDesc(videos.filter((v) => v.contentFormat === "live_archive"))

  if (liveNow) return [liveNow, ...archives.slice(0, count - 1)]
  return archives.slice(0, count)
}
