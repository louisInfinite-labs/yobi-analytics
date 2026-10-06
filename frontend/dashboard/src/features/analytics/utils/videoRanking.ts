import { apiRequest } from "../../../shared/api/apiClient"

/** GET /creators/{creatorId}/videos/ranking (video-ranking product, R9):
 * one creator's own videos, ranked by the backend -- this frontend never
 * re-sorts or re-derives rank/growth itself. */
export type VideoRankingMetric = "total" | "1d" | "7d" | "30d"

/** A backend topic id (video_topics.TOPICS, GET /topics) or "all" -- not a
 * closed frontend union, so a new backend topic needs no change here. No
 * caller currently passes one (CreatorVideoRankingWidget always uses the
 * "all" default); see home-room/model/videoTopicCatalog.ts for the
 * dynamically-fetched topic list this same id space comes from. */
export type VideoRankingTopic = string

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
