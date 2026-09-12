import type { RecentVideo } from "../data/mockRecentVideos"
import type { CreatorStatus } from "../types/creatorStatus"

const RECENT_LIVE_WINDOW_MS = 24 * 60 * 60 * 1000

export interface LiveEmbedVideo {
  videoId: string
  title: string
}

/** The video (if any) that should render as a real, playable YouTube embed
 * in Home's scene frame: the creator's current live broadcast, or -- once
 * they've gone offline -- whichever archived stream ended most recently,
 * but only when that was within the last 24 hours. Anything older (or no
 * stream history at all) returns null; the scene frame then falls back to
 * its existing empty/status-line-only rendering -- that fallback's own
 * design is still an open decision, not this function's job. */
export function selectLiveEmbedVideo(
  status: CreatorStatus | undefined,
  streamVideos: RecentVideo[],
  now: Date,
): LiveEmbedVideo | null {
  if (status?.kind === "live") return { videoId: status.videoId, title: status.title }

  const mostRecentArchive = streamVideos
    .filter((video) => video.contentFormat === "live_archive")
    .filter((video) => now.getTime() - new Date(video.publishedAt).getTime() < RECENT_LIVE_WINDOW_MS)
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())[0]

  return mostRecentArchive ? { videoId: mostRecentArchive.videoId, title: mostRecentArchive.title } : null
}
