import { ApiError, apiRequest } from "../../../shared/api/apiClient"
import { parseBirthday, parseDebutDate } from "../model/milestoneCountdown"

/** One creator fixed milestone dates: GET /creators/{creatorId}/milestones. The backend returns the stored strings and nothing computed;
 * every countdown and anniversary number is derived in the browser (see model/milestoneCountdown.ts). */
export interface CreatorMilestones {
  creatorId: string
  /** "MM-DD", no year; absent when the stored value is not a usable birthday. */
  birthday?: string
  /** The ORIGINAL debut date, "YYYY-MM-DD" (graduated creators keep it); absent when the stored value is not a usable date. */
  debutDate?: string
}

export type CreatorMilestonesResult = { kind: "found"; milestones: CreatorMilestones } | { kind: "not_found" }

/** The response checked, never trusted: the wrong creator, or a response with NO usable date at all, is an error, so nothing fabricated or mismatched is
 * shown; a response with only one usable date keeps just that one (the dialog shows the other as unavailable). */
export async function fetchCreatorMilestones(creatorId: string): Promise<CreatorMilestonesResult> {
  let dto: { creatorId?: unknown; birthday?: unknown; debutDate?: unknown }
  try {
    dto = await apiRequest<typeof dto>(`/creators/${encodeURIComponent(creatorId)}/milestones`)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { kind: "not_found" }
    throw error
  }
  const birthday = parseBirthday(dto.birthday) ? (dto.birthday as string) : undefined
  const debutDate = parseDebutDate(dto.debutDate) ? (dto.debutDate as string) : undefined
  if (dto.creatorId !== creatorId || (birthday === undefined && debutDate === undefined)) {
    throw new Error("Creator milestones response is not valid for this creator")
  }
  return { kind: "found", milestones: { creatorId, ...(birthday !== undefined && { birthday }), ...(debutDate !== undefined && { debutDate }) } }
}

const settled = new Map<string, CreatorMilestonesResult>()
const inFlight = new Map<string, Promise<CreatorMilestonesResult>>()

/** The result already held for this creator, or undefined -- lets a caller render at once, with no request. */
export function getCachedCreatorMilestones(creatorId: string): CreatorMilestonesResult | undefined {
  return settled.get(creatorId)
}

/** Load one creator milestones once per page session: a settled result (found or not found) is reused for every later open and creator
 * switch back, and concurrent callers share one request. A failure is NOT cached, so the next open retries. The dates never change, so the
 * one-second countdown never needs another read. */
export function loadCreatorMilestones(creatorId: string): Promise<CreatorMilestonesResult> {
  const cached = settled.get(creatorId)
  if (cached) return Promise.resolve(cached)
  const pending = inFlight.get(creatorId)
  if (pending) return pending
  const request = fetchCreatorMilestones(creatorId)
    .then((result) => {
      settled.set(creatorId, result)
      return result
    })
    .finally(() => {
      inFlight.delete(creatorId)
    })
  inFlight.set(creatorId, request)
  return request
}

/** Test hook: forget every settled and in-flight result. */
export function clearCreatorMilestonesCache(): void {
  settled.clear()
  inFlight.clear()
}