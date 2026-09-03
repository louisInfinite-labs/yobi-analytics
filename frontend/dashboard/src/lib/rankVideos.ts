import type { DailyVideoStat } from "../types/domain"

export type RankingType = "most_viewed" | "fastest_growing" | "trending"

export interface RankedVideo {
  rank: number
  video: DailyVideoStat
  value: number
}

/** Mirrors the backend's src/trending.py rank_videos ranking rules (Roadmap
 * 3.2/3.3): a video without the ranked metric available is excluded rather
 * than sorted as if it were zero. */
export function rankVideos(stats: DailyVideoStat[], rankingType: RankingType, limit?: number): RankedVideo[] {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new RangeError(`limit must be a non-negative integer, got ${limit}`)
  }

  const withValue = stats
    .map((video) => ({ video, value: metricFor(video, rankingType) }))
    .filter((entry): entry is { video: DailyVideoStat; value: number } => entry.value !== null)

  withValue.sort((a, b) => b.value - a.value)
  const limited = limit !== undefined ? withValue.slice(0, limit) : withValue

  return limited.map((entry, index) => ({ rank: index + 1, video: entry.video, value: entry.value }))
}

function metricFor(video: DailyVideoStat, rankingType: RankingType): number | null {
  if (video.status !== "ok") return null
  switch (rankingType) {
    case "most_viewed":
      return video.totalViews
    case "fastest_growing":
      return video.growthPercent
    case "trending":
      return video.dailyIncrease
  }
}
