import type { RecentVideo } from "../data/mockRecentVideos"

function sortByPublishedDesc(videos: RecentVideo[]): RecentVideo[] {
  return [...videos].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
}

/** The 2 latest normal (non-live) videos, most recent first. */
export function selectLatestVideos(videos: RecentVideo[], count = 2): RecentVideo[] {
  return sortByPublishedDesc(videos.filter((v) => v.contentFormat === "normal_video")).slice(0, count)
}

/** The livestream row's 2 slots:
 *  - currently live now → [live now, most recent completed stream]
 *  - otherwise → [most recent completed stream, 2nd most recent completed stream]
 * (this session's own spec: "如果目前有直播 顯示 現在直播 + 最新直播"). */
export function selectLivestreamSlots(videos: RecentVideo[]): RecentVideo[] {
  const liveNow = videos.find((v) => v.contentFormat === "live_now")
  const archives = sortByPublishedDesc(videos.filter((v) => v.contentFormat === "live_archive"))

  if (liveNow) return [liveNow, ...archives.slice(0, 1)]
  return archives.slice(0, 2)
}
