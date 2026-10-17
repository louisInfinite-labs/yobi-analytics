import { apiRequest } from "../../../shared/api/apiClient"

/** Home's Oshi Status panel read model for ONE creator: GET /creators/{creatorId}/oshi-status.
 * The panel's header numbers (subscriber count, since-last-visit and this-week counts, channel view
 * growth) come from this one bounded response -- the browser derives nothing from raw history, and the
 * current live/upcoming stream stays GET /live-streams' job. The Latest Activity rows are NOT read from
 * here: they page the same dataset as Video List ALL (see useHomeAllFeed), so this S3-only `recent` list is
 * requested at its minimum size (the backend requires at least 1) and never shown. */

export const OSHI_STATUS_RECENT_LIMIT = 1

export type OshiStatusGrowthWindow = "1d" | "7d" | "30d"

export interface OshiStatusItem {
  videoId: string
  title: string
  thumbnailUrl: string | null
  publishedAt: string
  currentViewCount: number | null
}

export interface OshiStatusData {
  /** The creator's current subscriber count, or null when the backend has none -- never a fabricated 0. */
  subscriberCount: number | null
  latestVideo: OshiStatusItem | null
  thisWeek: { newUploads: number; newStreams: number }
  /** Channel-level view growth (sum over the creator's tracked videos) per window. */
  growth: Record<OshiStatusGrowthWindow, { absoluteGrowth: number; videoCount: number }>
  /** Null when no `since` was sent (a first visit). */
  sinceLastVisit: { newUploads: number; newStreams: number; clamped: boolean } | null
}

interface OshiStatusItemDto {
  videoId?: unknown
  title?: unknown
  thumbnailUrl?: unknown
  publishedAt?: unknown
  currentViewCount?: unknown
}

interface OshiStatusDto {
  subscriberCount?: unknown
  latestVideo?: OshiStatusItemDto | null
  thisWeek?: { newUploads?: unknown; newStreams?: unknown } | null
  growth?: Partial<Record<OshiStatusGrowthWindow, { absoluteGrowth?: unknown; videoCount?: unknown }>> | null
  sinceLastVisit?: { newUploads?: unknown; newStreams?: unknown; clamped?: unknown } | null
}

/** The request path. `since` is the browser's stored last-visit time, sent as an ISO UTC timestamp;
 * a first visit has none, so the parameter is omitted. */
export function buildOshiStatusPath(creatorId: string, since: Date | null): string {
  const params = new URLSearchParams({ recentLimit: String(OSHI_STATUS_RECENT_LIMIT) })
  if (since) params.set("since", since.toISOString())
  return `/creators/${encodeURIComponent(creatorId)}/oshi-status?${params}`
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** One response item as a typed item, or null when it lacks a videoId / publishedAt. */
function toItem(dto: OshiStatusItemDto): OshiStatusItem | null {
  if (typeof dto.videoId !== "string" || typeof dto.publishedAt !== "string") return null
  return {
    videoId: dto.videoId,
    title: typeof dto.title === "string" ? dto.title : "",
    thumbnailUrl: typeof dto.thumbnailUrl === "string" ? dto.thumbnailUrl : null,
    publishedAt: dto.publishedAt,
    currentViewCount: typeof dto.currentViewCount === "number" ? dto.currentViewCount : null,
  }
}

function toGrowth(dto: OshiStatusDto["growth"], window: OshiStatusGrowthWindow) {
  return { absoluteGrowth: count(dto?.[window]?.absoluteGrowth), videoCount: count(dto?.[window]?.videoCount) }
}

export async function fetchOshiStatus(creatorId: string, since: Date | null): Promise<OshiStatusData> {
  const dto = await apiRequest<OshiStatusDto>(buildOshiStatusPath(creatorId, since))

  return {
    subscriberCount: typeof dto.subscriberCount === "number" && Number.isFinite(dto.subscriberCount) ? dto.subscriberCount : null,
    latestVideo: dto.latestVideo ? toItem(dto.latestVideo) : null,
    thisWeek: { newUploads: count(dto.thisWeek?.newUploads), newStreams: count(dto.thisWeek?.newStreams) },
    growth: { "1d": toGrowth(dto.growth, "1d"), "7d": toGrowth(dto.growth, "7d"), "30d": toGrowth(dto.growth, "30d") },
    sinceLastVisit: dto.sinceLastVisit
      ? {
          newUploads: count(dto.sinceLastVisit.newUploads),
          newStreams: count(dto.sinceLastVisit.newStreams),
          clamped: dto.sinceLastVisit.clamped === true,
        }
      : null,
  }
}
