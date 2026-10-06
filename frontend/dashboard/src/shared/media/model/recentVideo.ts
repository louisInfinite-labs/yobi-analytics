import type { ContentFormat } from "../../../entities/creator/model/domain"

export interface RecentVideo {
  videoId: string
  title: string
  publishedAt: string
  contentFormat: ContentFormat
  /** Backs the video-section sort dropdown's "most views" option — optional
   * for the same reason as `category` (holodexClient.ts's mapVideo doesn't
   * derive this either); treat a missing value as 0 wherever this is read
   * (see recentVideosSelection.ts's sortVideos). */
  viewCount?: number
}
