import { apiRequest, isHistoricalDataUnavailable } from "../../../shared/api/apiClient"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import { buildOshiVideosRequest, type OshiVideosQuery } from "../model/oshiVideosQuery"

/** One Oshi Videos shelf fetch for ONE creator (see oshiVideosQuery.ts): the
 * backend filters creator -> topic -> contentType -> sort/ranking before it
 * limits, so what comes back already belongs to `query.creatorId` and the
 * requested topic/content type -- nothing is filtered or re-sorted again in
 * the browser, and no growth is computed here. */

/** The fields of a GET .../videos/recent item and a GET .../videos/ranking row this shelf reads. */
interface ShelfVideoDto {
  videoId: string
  title: string | null
  publishedAt?: string | null
  contentType: string | null
  currentViewCount: number
}

interface RecentResponse {
  videos: ShelfVideoDto[]
  hasMore: boolean
}

interface RankingResponse {
  rows: ShelfVideoDto[]
}

export interface OshiVideosPage {
  videos: RecentVideo[]
  nextOffset: number
  hasMore: boolean
}

/** "live" (an archived livestream) -> live_archive; everything else a plain video.
 * A video whose publishedAt is unknown gets the epoch: it still renders (with
 * no date) rather than being dropped. */
function toRecentVideo(dto: ShelfVideoDto): RecentVideo {
  return {
    videoId: dto.videoId,
    title: dto.title ?? "",
    publishedAt: dto.publishedAt ?? new Date(0).toISOString(),
    contentFormat: dto.contentType === "live" ? "live_archive" : "normal_video",
    viewCount: dto.currentViewCount,
  }
}

export async function fetchOshiVideos(query: OshiVideosQuery, offset = 0): Promise<OshiVideosPage> {
  try {
    return await fetchOshiVideosPage(query, offset)
  } catch (err) {
    // A creator with no available historical catalog is a valid empty shelf, not an error.
    if (isHistoricalDataUnavailable(err)) return { videos: [], nextOffset: offset, hasMore: false }
    throw err
  }
}

async function fetchOshiVideosPage(query: OshiVideosQuery, offset: number): Promise<OshiVideosPage> {
  const request = buildOshiVideosRequest(query, offset)

  if (request.paged) {
    const response = await apiRequest<RecentResponse>(request.path)
    return {
      videos: response.videos.map(toRecentVideo),
      nextOffset: offset + response.videos.length,
      hasMore: response.hasMore,
    }
  }

  const response = await apiRequest<RankingResponse>(request.path)
  return { videos: response.rows.map(toRecentVideo), nextOffset: response.rows.length, hasMore: false }
}
