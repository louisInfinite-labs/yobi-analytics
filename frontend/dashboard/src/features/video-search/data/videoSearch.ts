import { apiRequest, isHistoricalDataUnavailable } from "../../../shared/api/apiClient"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import type { VideoContentType, VideoViewWindow } from "../../home-room/model/oshiVideosQuery"
import type { VideoSortOption } from "../../home-room/utils/recentVideosSelection"

/** GET /creators/{creatorId}/videos/search's own row shape (src/api/read_api.py's
 * get_creator_video_search). `topic` is the row's own persisted canonical topic id (already an existing
 * field, not new) -- the Search-session cache's local narrowing uses it together with this SAME
 * frontend's already-downloaded /topics catalog (see ../model/topicResolution.ts) to re-verify a result
 * against a longer query, entirely locally. There is no more backend-computed per-row match evidence
 * field (`matchedTopicAliases` was removed once this became redundant -- see ../model/
 * searchSessionCache.ts's own docstring). */
interface VideoSearchResultDto {
  videoId: string
  title: string | null
  publishedAt?: string | null
  contentType: string | null
  currentViewCount: number
  topic: string | null
}

interface VideoSearchResponse {
  videos: VideoSearchResultDto[]
}

export interface VideoSearchQuery {
  creatorId: string
  rawQuery: string
  /** The literal title-search terms the frontend expanded from `rawQuery` against the Topic Catalog's labels and aliases (see
   * ../model/topicResolution.ts expandSearchTerms) -- normalized and de-duplicated; empty is the normal "nothing resolved" case. The
   * backend only compares them to video TITLES. NEVER a topic id and never the user's separately-remembered browsing Tag (which Search
   * always ignores). */
  terms: readonly string[]
  contentType: VideoContentType
  sort: VideoSortOption
  viewWindow: VideoViewWindow
}

/** A search result -- a superset of RecentVideo, so it is usable anywhere a plain RecentVideo is
 * expected (card rendering never reads the extra field). `topic` is null for a video with no persisted
 * topic (can then only ever match -- and locally narrow -- by title). */
export interface VideoSearchResult extends RecentVideo {
  topic: string | null
}

/** Mirrors features/home-room/data/oshiVideos.ts's own toRecentVideo exactly (same DTO shape, same
 * mapping rule) -- a separate copy here rather than importing it, since that function isn't exported
 * and belongs to a module with its own, unrelated (paginated shelf) request-building logic. */
function toVideoSearchResult(dto: VideoSearchResultDto): VideoSearchResult {
  return {
    videoId: dto.videoId,
    title: dto.title ?? "",
    publishedAt: dto.publishedAt ?? new Date(0).toISOString(),
    contentFormat: dto.contentType === "live" ? "live_archive" : dto.contentType === "short" ? "shorts" : "normal_video",
    viewCount: dto.currentViewCount,
    topic: dto.topic,
  }
}

/** The backend returns EVERY matching video for one query in ONE response -- no `limit`/`offset`/`hasMore` at all (src/api/read_api.py's
 * get_creator_video_search). Every successful response is therefore a complete result set -- see ../model/searchSessionCache.ts.
 *
 * `query.rawQuery` is ALWAYS sent, independently of whether anything expanded. `query.terms` (the expanded literal title terms) is sent
 * as a JSON array in the `terms` parameter -- a JSON array, not a comma list, because an alias may contain a comma -- and omitted entirely
 * when empty. The request never carries a topic id: SearchView matches on titles only. */
export async function fetchVideoSearch(query: VideoSearchQuery, signal?: AbortSignal): Promise<VideoSearchResult[]> {
  try {
    const params = new URLSearchParams({ q: query.rawQuery, contentType: query.contentType, sort: query.sort })
    if (query.sort === "mostViews") params.set("metric", query.viewWindow)
    if (query.terms.length > 0) params.set("terms", JSON.stringify(query.terms))
    const response = await apiRequest<VideoSearchResponse>(`/creators/${encodeURIComponent(query.creatorId)}/videos/search?${params}`, { signal })
    return response.videos.map(toVideoSearchResult)
  } catch (err) {
    // A creator with no available historical catalog is a valid empty result, not an error -- same
    // handling as every other per-creator video endpoint (features/home-room/data/oshiVideos.ts).
    if (isHistoricalDataUnavailable(err)) return []
    throw err
  }
}
