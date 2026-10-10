import type { ContentFormat } from "../../../entities/creator/model/domain"

export interface RecentVideo {
  videoId: string
  title: string
  publishedAt: string
  /** The stream's real start (actualStart, else scheduledStart) when the source exposes it -- only GET /live-streams does.
   * NEW prefers it over `publishedAt`, which for a livestream is when the broadcast was created/scheduled. */
  eventAt?: string
  contentFormat: ContentFormat
  /** Backs the video-section sort dropdown's "most views" option — optional
   * for the same reason as `category` (holodexClient.ts's mapVideo doesn't
   * derive this either); treat a missing value as 0 wherever this is read
   * (see recentVideosSelection.ts's sortVideos). */
  viewCount?: number
}
