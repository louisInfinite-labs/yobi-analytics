import { apiRequest } from "../../../shared/api/apiClient"
import { parseBirthday, parseDebutDate } from "../model/milestoneCountdown"

/** Every creator fixed milestone dates in ONE read: GET /milestones -> { milestones: [{ creatorId, birthday, debutDate }, ...] }. The Live Status list needs
 * them for the whole roster, so this is a single bulk request, shared by every component and cached in memory. */
export interface MilestoneDates {
  birthday: string
  debutDate: string
}

export type AllCreatorMilestones = Record<string, MilestoneDates>

interface BulkDto {
  milestones?: unknown
}

/** Checked, never trusted: a record without a usable id, birthday or debut date is skipped (nothing is invented or repaired). */
export async function fetchAllCreatorMilestones(): Promise<AllCreatorMilestones> {
  const dto = await apiRequest<BulkDto>("/milestones")
  if (!Array.isArray(dto.milestones)) throw new Error("Milestones response has no list")
  const byId: AllCreatorMilestones = {}
  for (const record of dto.milestones as Array<Record<string, unknown>>) {
    const { creatorId, birthday, debutDate } = record ?? {}
    if (typeof creatorId !== "string" || !creatorId || !parseBirthday(birthday) || !parseDebutDate(debutDate)) continue
    byId[creatorId] = { birthday: birthday as string, debutDate: debutDate as string }
  }
  return byId
}

/** How long a successful read is fresh: one hour, the same lifetime as the backend warm-Lambda cache and the response Cache-Control (a corrected date is
 * therefore picked up within a bounded time even in a tab that stays open for days). */
export const FRESH_FOR_MS = 60 * 60 * 1000

/** After a failed read (including a route that does not exist yet) the next attempt waits this long, so a missing or failing endpoint is not retried on
 * every render, remount or focus. */
export const FAILURE_RETRY_MS = 5 * 60 * 1000

let held: { data: AllCreatorMilestones; fetchedAt: number } | null = null
let inFlight: Promise<AllCreatorMilestones> | null = null
let failedAt: number | null = null

/** The data already held, FRESH OR STALE (null if none was ever loaded): lets a caller render at once, with no request. Stale data is still the last good
 * answer, so it keeps showing while a revalidation is pending or when it fails. */
export function getCachedAllCreatorMilestones(): AllCreatorMilestones | null {
  return held ? held.data : null
}

/** True when nothing is held, or what is held is older than FRESH_FOR_MS. */
export function isAllCreatorMilestonesStale(now: number = Date.now()): boolean {
  return held === null || now - held.fetchedAt >= FRESH_FOR_MS
}

/** The dates, loading them only when needed:
 *  - fresh data is returned as is, with NO request;
 *  - missing or stale data is (re)validated with one request, shared by every concurrent caller (no polling: this runs only when a caller asks);
 *  - if that request fails, previously held data is returned unchanged (a temporary network failure never discards good data) and the next attempt waits
 *    FAILURE_RETRY_MS; with nothing held the failure rejects.
 * Nothing here is tied to the clock reaching JST midnight: the dates do not change at midnight, only their freshness ages. */
export function loadAllCreatorMilestones(now: () => number = Date.now): Promise<AllCreatorMilestones> {
  if (held && !isAllCreatorMilestonesStale(now())) return Promise.resolve(held.data)
  if (inFlight) return inFlight
  if (failedAt !== null && now() - failedAt < FAILURE_RETRY_MS) {
    return held ? Promise.resolve(held.data) : Promise.reject(new Error("Milestones are unavailable (retry later)"))
  }
  inFlight = fetchAllCreatorMilestones()
    .then((result) => {
      held = { data: result, fetchedAt: now() }
      failedAt = null
      return result
    })
    .catch((error: unknown) => {
      failedAt = now()
      if (held) return held.data
      throw error
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** Test hook: forget everything held. */
export function resetAllCreatorMilestonesForTests(): void {
  held = null
  inFlight = null
  failedAt = null
}