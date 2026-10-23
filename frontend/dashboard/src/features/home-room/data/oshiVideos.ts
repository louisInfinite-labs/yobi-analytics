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
  thumbnailUrl?: string | null
  discoveredAt?: string | null
  /** Only on a completed Premiere's row: when the lifecycle verified its replay available (see read_api's overlay). */
  archiveAvailableAt?: string | null
  /** The backend marks a row it assembled from a discovery event (or the verified-archive overlay) until the daily run replaces it. */
  provisional?: boolean | null
  /** Only on an announced upcoming Premiere's provisional row: its scheduled start. */
  scheduledStart?: string | null
}

/** GET .../videos/recent's `newContent` (only present when the request carried `newSince`): the NEW-eligible part of the WHOLE list as exact
 * counts plus comma-joined id lists per group. Unclassified = no persisted contentType yet. */
interface NewContentDto {
  videoIds?: unknown
  livestreamIds?: unknown
  unclassifiedIds?: unknown
}

interface RecentResponse {
  videos: ShelfVideoDto[]
  hasMore: boolean
  newContent?: NewContentDto | null
}

/** The ids of EVERY record of the whole ALL list first discovered since the tracking baseline (loaded page or not), exact and uncapped. */
export interface NewContentEligibility {
  videoIds: string[]
  livestreamIds: string[]
  /** No persisted contentType yet: eligible and counted, but never reclassified here. */
  unclassifiedIds: string[]
}

interface RankingResponse {
  rows: ShelfVideoDto[]
}

export interface OshiVideosPage {
  videos: RecentVideo[]
  nextOffset: number
  hasMore: boolean
  /** Present only on a first page requested with `newSince`, and only when the backend answered it. */
  newContent?: NewContentEligibility
}

/** "live" (an archived livestream) -> live_archive; "short" (the backend's own persisted classification) -> shorts;
 * everything else a plain video.
 * A video whose publishedAt is unknown gets the epoch: it still renders (with
 * no date) rather than being dropped. */
function toRecentVideo(dto: ShelfVideoDto): RecentVideo {
  // An announced Premiere (a provisional row with a scheduled start, no contentType and no confirmed archive time) is not a watchable video yet: it is the Premiere's row, in
  // the not-yet-watchable "premiere" format and ordered by its scheduled start, exactly like its live-list row -- so it is never counted, never NEW and never marked watched
  // while the Premiere is airing or its end is not confirmed yet. Any other provisional row (an ordinary new video) is mapped as before.
  const announced = Boolean(dto.provisional && !dto.contentType && dto.scheduledStart && !dto.archiveAvailableAt)
  return {
    videoId: dto.videoId,
    title: dto.title ?? "",
    publishedAt: dto.publishedAt ?? new Date(0).toISOString(),
    contentFormat: announced ? "premiere" : dto.contentType === "live" ? "live_archive" : dto.contentType === "short" ? "shorts" : "normal_video",
    viewCount: dto.currentViewCount,
    thumbnailUrl: dto.thumbnailUrl ?? null,
    discoveredAt: dto.discoveredAt ?? null,
    ...(dto.archiveAvailableAt ? { archiveAvailableAt: dto.archiveAvailableAt } : {}),
    ...(announced ? { announcedPremiere: true, eventAt: dto.scheduledStart as string } : {}),
  }
}

/** The comma-joined id list of one group as an array (an absent or odd value is an empty group). */
function splitIds(value: unknown): string[] {
  return typeof value === "string" ? value.split(",").filter(Boolean) : []
}

/** The response's newContent as typed eligibility, or undefined when absent (an older backend). */
function toNewContent(raw: RecentResponse["newContent"]): NewContentEligibility | undefined {
  if (!raw) return undefined
  return { videoIds: splitIds(raw.videoIds), livestreamIds: splitIds(raw.livestreamIds), unclassifiedIds: splitIds(raw.unclassifiedIds) }
}

/** One Video List page; a creator with no historical catalog is a valid empty page. `options.newSince` rides on the first page only. */
export async function fetchOshiVideos(query: OshiVideosQuery, offset = 0, options: { newSince?: string } = {}): Promise<OshiVideosPage> {
  try {
    return await fetchOshiVideosPage(query, offset, options)
  } catch (err) {
    // A creator with no available historical catalog is a valid empty shelf, not an error.
    if (isHistoricalDataUnavailable(err)) return { videos: [], nextOffset: offset, hasMore: false }
    throw err
  }
}

async function fetchOshiVideosPage(query: OshiVideosQuery, offset: number, options: { newSince?: string }): Promise<OshiVideosPage> {
  const request = buildOshiVideosRequest(query, offset, options)

  if (request.paged) {
    const response = await apiRequest<RecentResponse>(request.path)
    const newContent = toNewContent(response.newContent)
    return {
      videos: response.videos.map(toRecentVideo),
      nextOffset: offset + response.videos.length,
      hasMore: response.hasMore,
      ...(newContent ? { newContent } : {}),
    }
  }

  const response = await apiRequest<RankingResponse>(request.path)
  return { videos: response.rows.map(toRecentVideo), nextOffset: response.rows.length, hasMore: false }
}
