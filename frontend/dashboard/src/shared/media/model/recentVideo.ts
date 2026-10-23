import type { ContentFormat } from "../../../entities/creator/model/domain"

export interface RecentVideo {
  videoId: string
  title: string
  publishedAt: string
  /** The stream's real start (actualStart, else scheduledStart) when the source exposes it -- only GET /live-streams does.
   * NEW prefers it over `publishedAt`, which for a livestream is when the broadcast was created/scheduled. */
  eventAt?: string
  contentFormat: ContentFormat
  /** The backend's own thumbnail for this video when the source carries one; the row falls back to the videoId-keyed YouTube image. */
  thumbnailUrl?: string | null
  /** Backs the video-section sort dropdown's "most views" option — optional
   * for the same reason as `category` (holodexClient.ts's mapVideo doesn't
   * derive this either); treat a missing value as 0 wherever this is read
   * (see recentVideosSelection.ts's sortVideos). */
  viewCount?: number
  /** When AWS first discovered the video (null when the backend has no such time); absent for sources that do not carry it. NEW counts from it. */
  discoveredAt?: string | null
  /** A completed Premiere only: when its replay was verified available. A Premiere is announced long before its replay can be watched, so NEW counts from this
   * time (never from the announcement) once it is present. */
  archiveAvailableAt?: string | null
  /** True only for an ANNOUNCED Premiere's row: built by the backend from the announcement event alone (flagged provisional, no persisted contentType, a scheduled start, no
   * confirmed archive). It is a Premiere that is not watchable yet (contentFormat "premiere", eventAt = its scheduled start) and the weakest source for its videoId: a
   * live/upcoming stream, an archive-pending placeholder or a confirmed archive row always replaces it. An ordinary provisional (newly discovered) row never carries this. */
  announcedPremiere?: boolean
}
