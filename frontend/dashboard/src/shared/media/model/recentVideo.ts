import type { ContentFormat } from "../../../entities/creator/model/domain"
import type { VideoCategory } from "./videoCategory"

export interface RecentVideo {
  videoId: string
  title: string
  publishedAt: string
  contentFormat: ContentFormat
  /** Home's video-section tag filter (this session's spec) — optional
   * since real/Holodex-fetched videos (holodexClient.ts's mapVideo) don't
   * derive this; treat a missing value as "other" wherever this is read. */
  category?: VideoCategory
  /** Backs the video-section sort dropdown's "most views" option — optional
   * for the same reason as `category` (holodexClient.ts's mapVideo doesn't
   * derive this either); treat a missing value as 0 wherever this is read
   * (see recentVideosSelection.ts's sortVideos). */
  viewCount?: number
}
