import { apiRequest } from "../../../shared/api/apiClient"

/** Home's Oshi Status panel read model for ONE creator: GET /creators/{creatorId}/oshi-status.
 * Everything the panel shows (subscriber count, since-last-visit and this-week counts, channel view
 * growth, the recent rows) comes from this one bounded response -- the browser derives nothing from
 * raw history, and the current live/upcoming stream stays GET /live-streams' job. */

export const OSHI_STATUS_RECENT_LIMIT = 6

export type OshiStatusGrowthWindow = "1d" | "7d" | "30d"

export interface OshiStatusRecentItem {
  videoId: string
  kind: "upload" | "livestream"
  title: string
  thumbnailUrl: string | null
  publishedAt: string
  currentViewCount: number | null
}

export interface OshiStatusData {
  /** The creator's current subscriber count, or null when the backend has none -- never a fabricated 0. */
  subscriberCount: number | null
  latestVideo: Omit<OshiStatusRecentItem, "kind"> | null
  thisWeek: { newUploads: number; newStreams: number }
  /** Channel-level view growth (sum over the creator's tracked videos) per window. */
  growth: Record<OshiStatusGrowthWindow, { absoluteGrowth: number; videoCount: number }>
  recent: OshiStatusRecentItem[]
  /** Null when no `since` was sent (a first visit). */
  sinceLastVisit: { newUploads: number; newStreams: number; clamped: boolean } | null
}

interface OshiStatusItemDto {
  videoId?: unknown
  kind?: unknown
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
  recent?: OshiStatusItemDto[] | null
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

function toItem(dto: OshiStatusItemDto): Omit<OshiStatusRecentItem, "kind"> | null {
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

  const recent: OshiStatusRecentItem[] = []
  for (const raw of dto.recent ?? []) {
    const item = toItem(raw)
    if (item) recent.push({ ...item, kind: raw.kind === "livestream" ? "livestream" : "upload" })
  }

  return {
    subscriberCount: typeof dto.subscriberCount === "number" && Number.isFinite(dto.subscriberCount) ? dto.subscriberCount : null,
    latestVideo: dto.latestVideo ? toItem(dto.latestVideo) : null,
    thisWeek: { newUploads: count(dto.thisWeek?.newUploads), newStreams: count(dto.thisWeek?.newStreams) },
    growth: { "1d": toGrowth(dto.growth, "1d"), "7d": toGrowth(dto.growth, "7d"), "30d": toGrowth(dto.growth, "30d") },
    recent,
    sinceLastVisit: dto.sinceLastVisit
      ? {
          newUploads: count(dto.sinceLastVisit.newUploads),
          newStreams: count(dto.sinceLastVisit.newStreams),
          clamped: dto.sinceLastVisit.clamped === true,
        }
      : null,
  }
}
