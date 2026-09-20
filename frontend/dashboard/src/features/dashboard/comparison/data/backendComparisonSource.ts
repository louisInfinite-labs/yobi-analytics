import { apiRequest } from "../../../../shared/api/apiClient"
import type { ComparisonSource } from "./dashboardComparisonSource"
import type { ComparisonItem } from "../model/dashboardComparisonCatalog"
import type { ComparisonCreatorResult, ComparisonDataRequest, ComparisonDataResponse } from "../model/dashboardComparisonData"

/** Report date and time zone a comparison request is evaluated for -- the
 * same two values every Read API request carries. */
export interface ComparisonRequestContext {
  reportDate: string
  timeZone: string
}

interface ComparisonItemsResponse {
  comparisonItems: ComparisonItem[]
}

interface BackendCreatorResult {
  creatorId: string
  status: "ok" | "unavailable" | "error"
  points?: { label: string; value: number }[]
}

interface ComparisonDataBackendResponse {
  items: { comparisonItemId: string; creators: BackendCreatorResult[] }[]
}

/** The Dashboard's creator list uses `ch_<creatorId>` for a creator's
 * `channelId` (the frontend roster's id form), while Creator Master and every
 * backend route use the bare `creatorId`. The two id forms differ only by
 * this prefix (the same convention the Favorites bridge relies on); it is
 * translated here, at the network boundary, so saved widget configuration
 * keeps the roster ids. A roster creator with no Creator Master counterpart
 * simply comes back `unavailable`. */
const ROSTER_ID_PREFIX = "ch_"

export function toBackendCreatorId(rosterId: string): string {
  return rosterId.startsWith(ROSTER_ID_PREFIX) ? rosterId.slice(ROSTER_ID_PREFIX.length) : rosterId
}

export function fromBackendCreatorId(backendId: string, requestedRosterIds: readonly string[]): string {
  const match = requestedRosterIds.find((rosterId) => toBackendCreatorId(rosterId) === backendId)
  return match ?? backendId
}

function toCreatorResult(result: BackendCreatorResult, rosterId: string): ComparisonCreatorResult {
  if (result.status === "ok") return { status: "ok", creatorId: rosterId, points: result.points ?? [] }
  return { status: result.status, creatorId: rosterId }
}

/** The production `ComparisonSource`: `GET /dashboard/comparison-items` and
 * `GET /dashboard/comparison-data` on the real backend. Creator and item
 * order are sent exactly as given (comma-joined, never sorted). The backend
 * returns one entry per requested item in request order; a chart shows one
 * item, so the first entry's creators are used. */
export function createBackendComparisonSource(getContext: () => ComparisonRequestContext): ComparisonSource {
  return {
    origin: "backend",
    loadItems: async () => (await apiRequest<ComparisonItemsResponse>("/dashboard/comparison-items")).comparisonItems,
    fetchData: async (request: ComparisonDataRequest): Promise<ComparisonDataResponse> => {
      const { reportDate, timeZone } = getContext()
      const query = new URLSearchParams({
        creatorIds: request.creatorIds.map(toBackendCreatorId).join(","),
        comparisonItemIds: request.comparisonItemIds.join(","),
        reportDate,
        timeZone,
      })
      const response = await apiRequest<ComparisonDataBackendResponse>(`/dashboard/comparison-data?${query}`)
      const first = response.items[0]
      if (!first) return { creators: [] }
      return { creators: first.creators.map((result) => toCreatorResult(result, fromBackendCreatorId(result.creatorId, request.creatorIds))) }
    },
  }
}
