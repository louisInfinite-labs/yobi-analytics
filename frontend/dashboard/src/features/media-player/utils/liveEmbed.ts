import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import type { CreatorStatus } from "../../live-status/model/creatorStatus"

export interface LiveEmbedVideo {
  videoId: string
  title: string
}

/** The video (if any) that should render as a real, playable YouTube embed
 * in Home's scene frame, in this priority: the creator's current live
 * broadcast; their next scheduled/upcoming stream (YouTube's own embed shows
 * its real waiting-room/"Premieres in..." state for a videoId that hasn't
 * gone live yet -- no separate fake waiting screen needed here); otherwise
 * the creator's MOST RECENT COMPLETED livestream, however long ago it ended
 * (the pool only ever holds contentType=live&liveStatus=completed archives,
 * so a plain upload or Short can never be picked). Only when the creator has
 * no completed livestream at all does this return null and the scene frame
 * keep its empty rendering, with no iframe. */
export function selectLiveEmbedVideo(
  status: CreatorStatus | undefined,
  streamVideos: RecentVideo[],
  now: Date,
): LiveEmbedVideo | null {
  if (status?.kind === "live") return { videoId: status.videoId, title: status.title }
  if (status?.kind === "upcoming") return { videoId: status.videoId, title: status.title }

  const mostRecentArchive = streamVideos
    .filter((video) => video.contentFormat === "live_archive")
    // A completed stream cannot start in the future: a future publishedAt is bad data, never "the latest".
    .filter((video) => now.getTime() - new Date(video.publishedAt).getTime() >= 0)
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())[0]

  return mostRecentArchive ? { videoId: mostRecentArchive.videoId, title: mostRecentArchive.title } : null
}
