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
  /** Canonical topic ids the frontend has ALREADY resolved from `rawQuery`, locally, against its own
   * downloaded /topics catalog (see ../model/topicResolution.ts) -- NOT the user's separately-remembered
   * browsing Video Tag, which must never be threaded through here (Search always ignores it). Empty is
   * the normal "this query didn't resolve to any topic" case, not an error: direct title matching via
   * `rawQuery` always applies regardless, and is never omitted just because this resolved to something. */
  topicIds: readonly string[]
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

/** Product correction (Search-session cache follow-up): the backend returns EVERY matching video for
 * one query in ONE response -- no `limit`/`offset`/`hasMore` at all (src/api/read_api.py's
 * get_creator_video_search no longer paginates Search; see that function's own docstring for the
 * measured payload-size justification). Every successful response is therefore, by construction,
 * already a complete result set -- see ../model/searchSessionCache.ts, which stores it as a
 * Search-session base with no separate "is this complete?" check needed.
 *
 * `query.rawQuery` (direct title matching) is ALWAYS sent, independently of whether `query.topicIds`
 * resolved to anything -- this is a hard product rule (see ../hooks/useVideoSearch.ts, the only caller,
 * for where `topicIds` is actually computed via ../model/topicResolution.ts). `topicIds` is sent as a
 * comma-separated `topicIds` parameter when non-empty (the project's existing multi-value query-param
 * convention, e.g. Holodex's own `channels=<comma-separated>`), and omitted entirely when empty -- never
 * an empty-string parameter, which `read_api.parse_video_search_topic_ids` would treat identically to
 * "absent" anyway, but omitting it keeps the request URL itself honest about having no topic filter. */
export async function fetchVideoSearch(query: VideoSearchQuery, signal?: AbortSignal): Promise<VideoSearchResult[]> {
  try {
    const params = new URLSearchParams({ q: query.rawQuery, contentType: query.contentType, sort: query.sort })
    if (query.sort === "mostViews") params.set("metric", query.viewWindow)
    if (query.topicIds.length > 0) params.set("topicIds", query.topicIds.join(","))
    const response = await apiRequest<VideoSearchResponse>(`/creators/${encodeURIComponent(query.creatorId)}/videos/search?${params}`, { signal })
    return response.videos.map(toVideoSearchResult)
  } catch (err) {
    // A creator with no available historical catalog is a valid empty result, not an error -- same
    // handling as every other per-creator video endpoint (features/home-room/data/oshiVideos.ts).
    if (isHistoricalDataUnavailable(err)) return []
    throw err
  }
}
