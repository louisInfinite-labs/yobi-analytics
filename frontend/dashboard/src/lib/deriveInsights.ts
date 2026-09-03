import type { DailyVideoStat } from "../types/domain"
import { formatCompactNumber, formatSignedPercent } from "./format"
import { deriveChannelContribution } from "./deriveAnalytics"
import { rankVideos } from "./rankVideos"

/** Two or three concise, data-focused observations — natural phrasing, no
 * unsupported causal claims (dashboard_ui_direction_en.md's Insight Copy
 * guidance). Returns fewer than 3 when the filtered set doesn't support them. */
export function deriveInsights(stats: DailyVideoStat[]): string[] {
  const insights: string[] = []

  const topVideo = rankVideos(stats, "trending", 1)[0]
  if (topVideo && topVideo.video.sevenDayAverage) {
    const vsAverage = ((topVideo.video.dailyIncrease - topVideo.video.sevenDayAverage) / topVideo.video.sevenDayAverage) * 100
    insights.push(
      `"${topVideo.video.videoTitle}" gained ${formatCompactNumber(topVideo.video.dailyIncrease)} views today, ` +
        `${vsAverage >= 0 ? Math.abs(vsAverage).toFixed(1) + "% above" : Math.abs(vsAverage).toFixed(1) + "% below"} its 7-day average.`,
    )
  }

  const contributions = deriveChannelContribution(stats)
  if (contributions[0]) {
    insights.push(`${contributions[0].channelName} contributed ${contributions[0].percent.toFixed(0)}% of today's total growth.`)
  }

  const fastest = rankVideos(stats, "fastest_growing", 1)[0]
  if (fastest) {
    insights.push(`"${fastest.video.videoTitle}" is the fastest-growing video today, ${formatSignedPercent(fastest.value)}.`)
  }

  return insights.slice(0, 3)
}
