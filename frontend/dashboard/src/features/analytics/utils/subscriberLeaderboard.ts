import { apiRequest } from "../../../shared/api/apiClient"

/** GET /subscribers/leaderboard (subscriber-leaderboard product, R9):
 * subscriber totals/growth ranked by the backend, org-scoped (never
 * creator-scoped -- there is no single-creator variant of this product). */
export type SubscriberLeaderboardMetric = "total" | "1d" | "7d" | "30d"

export type SubscriberLeaderboardOrganization = "all" | "vspo" | "hololive"

export interface SubscriberLeaderboardRow {
  rank: number
  creatorId: string
  organization: string | null
  subscriberCount?: number
  currentSubscriberCount?: number
  anchorSubscriberCount?: number
  absoluteGrowth?: number
  percentageGrowth?: number | null
}

export interface SubscriberLeaderboardResponse {
  reportDate: string
  generatedAt: string
  organization: SubscriberLeaderboardOrganization
  metric: SubscriberLeaderboardMetric
  expectedCreatorCount: number
  observedCreatorCount: number
  missingCreatorCount: number
  rows: SubscriberLeaderboardRow[]
  ineligible: Record<string, string>
}

/** RANKING_NOT_READY (503) is a well-formed, expected response, not a
 * network/server error -- see videoRanking.ts's own fetch function for the
 * identical contract. */
export async function fetchSubscriberLeaderboard(
  metric: SubscriberLeaderboardMetric,
  organization: SubscriberLeaderboardOrganization = "all",
): Promise<SubscriberLeaderboardResponse> {
  return apiRequest<SubscriberLeaderboardResponse>(
    `/subscribers/leaderboard?${new URLSearchParams({ metric, organization })}`,
  )
}
