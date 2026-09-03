import type { DailyVideoStat, Period } from "../types/domain"
import { formatCompactNumber, formatSignedPercent } from "./format"
import { deriveChannelContribution } from "./deriveAnalytics"
import { rankVideos } from "./rankVideos"

const PERIOD_ADVERB: Record<Period, string> = {
  "1d": "today",
  "7d": "over this 7-day period",
  "30d": "over this 30-day period",
}

const PERIOD_POSSESSIVE: Record<Period, string> = {
  "1d": "today's",
  "7d": "this 7-day period's",
  "30d": "this 30-day period's",
}

/** Two or three concise, data-focused observations — natural phrasing, no
 * unsupported causal claims (dashboard_ui_direction_en.md's Insight Copy
 * guidance). Returns fewer than 3 when the filtered set doesn't support them.
 *
 * The "vs 7-day average" insight only fires for period="1d": the mock
 * fixture's `sevenDayAverage` is never period-scaled (unlike `dailyIncrease`,
 * which `scaleStatsForPeriod` scales for 7d/30d — see src/lib/period.ts), so
 * comparing a scaled dailyIncrease against that fixed average for a longer
 * period would produce a misleading percentage. */
export function deriveInsights(stats: DailyVideoStat[], period: Period): string[] {
  const insights: string[] = []

  const topVideo = rankVideos(stats, "trending", 1)[0]
  if (period === "1d" && topVideo && topVideo.video.sevenDayAverage) {
    const vsAverage = ((topVideo.video.dailyIncrease - topVideo.video.sevenDayAverage) / topVideo.video.sevenDayAverage) * 100
    insights.push(
      `"${topVideo.video.videoTitle}" gained ${formatCompactNumber(topVideo.video.dailyIncrease)} views today, ` +
        `${vsAverage >= 0 ? Math.abs(vsAverage).toFixed(1) + "% above" : Math.abs(vsAverage).toFixed(1) + "% below"} its 7-day average.`,
    )
  } else if (topVideo) {
    insights.push(
      `"${topVideo.video.videoTitle}" gained ${formatCompactNumber(topVideo.video.dailyIncrease)} views ${PERIOD_ADVERB[period]}.`,
    )
  }

  const contributions = deriveChannelContribution(stats)
  if (contributions[0]) {
    insights.push(`${contributions[0].channelName} contributed ${contributions[0].percent.toFixed(0)}% of ${PERIOD_POSSESSIVE[period]} total growth.`)
  }

  const fastest = rankVideos(stats, "fastest_growing", 1)[0]
  if (fastest) {
    insights.push(`"${fastest.video.videoTitle}" is the fastest-growing video ${PERIOD_ADVERB[period]}, ${formatSignedPercent(fastest.value)}.`)
  }

  return insights.slice(0, 3)
}
