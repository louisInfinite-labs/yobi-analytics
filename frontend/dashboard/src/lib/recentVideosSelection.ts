import type { RecentVideo } from "../data/mockRecentVideos"

function sortByPublishedDesc(videos: RecentVideo[]): RecentVideo[] {
  return [...videos].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
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
