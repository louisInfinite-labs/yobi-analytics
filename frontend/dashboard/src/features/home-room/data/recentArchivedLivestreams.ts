import { apiRequest } from "../../../shared/api/apiClient"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

/** GET /creators/{creatorId}/videos/recent (Home "Latest Live" archive path):
 * one creator's own COMPLETED historical livestream archives, newest
 * published first -- sourced entirely from the AWS-persisted video-ranking
 * S3 result, never Holodex. contentType=live&liveStatus=completed is the
 * exact combination that excludes plain uploads AND the creator's own
 * current/upcoming stream (which the separate Holodex-backed /live-streams
 * path already owns) -- see backend api.read_api.get_recent_creator_videos'
 * own docstring for why liveStatus is a second, independent filter from
 * contentType. */

/** Mirrors HolodexPage's own page size (the former shelf hook's established
 * "Latest Videos" convention) -- this row's own bounded page, not a fetch of
 * the whole historical catalog. */
const ARCHIVE_PAGE_SIZE = 20

interface RecentCreatorVideoDto {
  videoId: string
  contentType: string | null
  liveStatus: string | null
  currentViewCount: number
  title: string | null
  publishedAt: string | null
}

interface RecentCreatorVideosResponse {
  videos: RecentCreatorVideoDto[]
  hasMore: boolean
}

export interface ArchivedLivestreamPage {
  videos: RecentVideo[]
  nextOffset: number
  hasMore: boolean
}

/** A row with no persisted contentType/liveStatus yet (legacy, not yet
 * classified) never reaches this mapper at all -- the backend's own
 * contentType=live&liveStatus=completed filter already excludes it, so
 * there's no "unclassified" case to guess a fallback for here. */
function toRecentVideo(dto: RecentCreatorVideoDto): RecentVideo {
  return {
    videoId: dto.videoId,
    title: dto.title ?? "",
    publishedAt: dto.publishedAt ?? new Date(0).toISOString(),
    contentFormat: "live_archive",
    viewCount: dto.currentViewCount,
  }
}

export async function fetchArchivedLivestreams(
  creatorId: string,
  { offset = 0 }: { offset?: number } = {},
): Promise<ArchivedLivestreamPage> {
  const response = await apiRequest<RecentCreatorVideosResponse>(
    `/creators/${encodeURIComponent(creatorId)}/videos/recent?${new URLSearchParams({
      contentType: "live",
      liveStatus: "completed",
      limit: String(ARCHIVE_PAGE_SIZE),
      offset: String(offset),
    })}`,
  )
  return {
    videos: response.videos.map(toRecentVideo),
    nextOffset: offset + response.videos.length,
    hasMore: response.hasMore,
  }
}
