import { apiRequest } from "../../../shared/api/apiClient"

/** GET /creators/{creatorId}/videos/ranking (video-ranking product, R9):
 * one creator's own videos, ranked by the backend -- this frontend never
 * re-sorts or re-derives rank/growth itself. */
export type VideoRankingMetric = "total" | "1d" | "7d" | "30d"

export type VideoRankingTopic = "all" | "valorant" | "sf6" | "apex" | "minecraft" | "singing" | "chatting" | "other"

export interface VideoRankingRow {
  rank: number
  videoId: string
  creatorId: string
  topic: string
  currentViewCount: number
  anchorViewCount?: number
  absoluteGrowth?: number
  percentageGrowth?: number | null
  title: string | null
  thumbnailUrl: string | null
}

export interface VideoRankingResponse {
  reportDate: string
  generatedAt: string
  creatorId: string
  metric: VideoRankingMetric
  topic: VideoRankingTopic
  rows: VideoRankingRow[]
}

/** RANKING_NOT_READY (503) is a well-formed, expected response -- the
 * backend hasn't computed this creator's ranking yet -- not a network/server
 * error. Callers should catch ApiError and check `code === "RANKING_NOT_READY"`
 * to distinguish it from a genuine failure. */
export async function fetchVideoRanking(
  creatorId: string,
  metric: VideoRankingMetric,
  topic: VideoRankingTopic = "all",
): Promise<VideoRankingResponse> {
  return apiRequest<VideoRankingResponse>(
    `/creators/${encodeURIComponent(creatorId)}/videos/ranking?${new URLSearchParams({ metric, topic })}`,
  )
}
