import { apiRequest, isHistoricalDataUnavailable } from "../../../shared/api/apiClient"
import { ON_THIS_DAY_TIME_ZONE, type MonthDay, type OnThisDayFilters } from "../model/onThisDay"

/** How a memory's date was decided: a livestream by its verified real start, anything else by its published date. */
export type MemoryDateKind = "actualStart" | "published"

/** One row of GET /creators/{creatorId}/videos/on-this-day (src/api/read_api.py's get_creator_videos_on_this_day). */
export interface MemoryVideo {
  videoId: string
  title: string
  topic: string | null
  contentType: string | null
  viewCount?: number
  /** The calendar date (Tokyo) the video is remembered on, YYYY-MM-DD. */
  date: string
  /** The exact instant behind `date`. */
  eventAt: string
  dateKind: MemoryDateKind
}

export interface MemoryYear {
  year: number
  videos: MemoryVideo[]
}

/** What the catalog can and cannot say: used to tell "nothing happened that day" from "the data does not cover it". */
export interface MemoryCoverage {
  /** The earliest dated video's date in the catalog, or null for an empty catalog. */
  catalogStart: string | null
  /** Completed livestreams whose real start is not recorded yet: they cannot be placed on any date. */
  undatedLivestreams: number
}

export interface OnThisDayResult {
  years: MemoryYear[]
  total: number
  /** The backend cut the list at its own safety cap. */
  truncated: boolean
  coverage: MemoryCoverage
  /** The creator has no available historical catalog (a valid empty answer, not an error). */
  unavailable: boolean
}

interface MemoryVideoDto {
  videoId: string
  title: string | null
  topic: string | null
  contentType: string | null
  currentViewCount?: number | null
  date: string
  eventAt: string
  dateKind: MemoryDateKind
}

interface OnThisDayResponse {
  years: { year: number; videos: MemoryVideoDto[] }[]
  total: number
  truncated: boolean
  coverage: { catalogStart: string | null; undatedLivestreams: number }
}

/** A result that says nothing: used while there is nothing to show and for a creator without a historical catalog. */
export const EMPTY_ON_THIS_DAY: OnThisDayResult = {
  years: [],
  total: 0,
  truncated: false,
  coverage: { catalogStart: null, undatedLivestreams: 0 },
  unavailable: false,
}

/** The request path for one creator + month/day + filters; the zone is always the app's Tokyo rule. */
export function buildOnThisDayPath(creatorId: string, monthDay: MonthDay, filters: OnThisDayFilters): string {
  const params = new URLSearchParams({
    month: String(monthDay.month),
    day: String(monthDay.day),
    timeZone: ON_THIS_DAY_TIME_ZONE,
    topic: filters.topic,
    contentType: filters.contentType,
    excludeShorts: String(filters.excludeShorts),
  })
  return `/creators/${encodeURIComponent(creatorId)}/videos/on-this-day?${params}`
}

/** Fetches one creator's same-month/day memories from earlier years; every year arrives in this one response (no paging, no polling). */
export async function fetchOnThisDay(creatorId: string, monthDay: MonthDay, filters: OnThisDayFilters, signal?: AbortSignal): Promise<OnThisDayResult> {
  try {
    const response = await apiRequest<OnThisDayResponse>(buildOnThisDayPath(creatorId, monthDay, filters), { signal })
    return {
      years: response.years.map((year) => ({
        year: year.year,
        videos: year.videos.map((video) => ({
          videoId: video.videoId,
          title: video.title ?? "",
          topic: video.topic,
          contentType: video.contentType,
          ...(typeof video.currentViewCount === "number" ? { viewCount: video.currentViewCount } : {}),
          date: video.date,
          eventAt: video.eventAt,
          dateKind: video.dateKind,
        })),
      })),
      total: response.total,
      truncated: response.truncated,
      coverage: { catalogStart: response.coverage.catalogStart, undatedLivestreams: response.coverage.undatedLivestreams },
      unavailable: false,
    }
  } catch (err) {
    // A creator with no available historical catalog is a valid empty answer, like every other per-creator video endpoint.
    if (isHistoricalDataUnavailable(err)) return { ...EMPTY_ON_THIS_DAY, unavailable: true }
    throw err
  }
}
