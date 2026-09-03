import type { DailyVideoStat } from "../types/domain"

export interface DashboardKpis {
  totalViews: number
  totalDailyIncrease: number
  averageGrowthPercent: number | null
  topPerformer: DailyVideoStat | null
}

/** Aggregate KPI numbers from a (already filtered) list of video stats.
 * Only "ok" entries contribute to growth totals — a pending/not_available
 * entry has no confirmed daily change to add, so it is excluded rather than
 * treated as a zero contribution (Roadmap 3.1 never fabricates a value). */
export function deriveKpis(stats: DailyVideoStat[]): DashboardKpis {
  const totalViews = stats.reduce((sum, s) => sum + s.totalViews, 0)

  const okStats = stats.filter((s) => s.status === "ok")
  const totalDailyIncrease = okStats.reduce((sum, s) => sum + s.dailyIncrease, 0)

  const withPercent = okStats.filter((s): s is DailyVideoStat & { growthPercent: number } => s.growthPercent !== null)
  const averageGrowthPercent =
    withPercent.length > 0 ? withPercent.reduce((sum, s) => sum + s.growthPercent, 0) / withPercent.length : null

  const topPerformer = okStats.reduce<DailyVideoStat | null>(
    (top, s) => (top === null || s.dailyIncrease > top.dailyIncrease ? s : top),
    null,
  )

  return { totalViews, totalDailyIncrease, averageGrowthPercent, topPerformer }
}

export interface ChannelContribution {
  channelId: string
  channelName: string
  dailyIncrease: number
  percent: number
}

/** Each channel's share of the filtered set's total positive daily growth,
 * deduplicated by channelId (a channel with several videos is one row,
 * summing its videos' growth) — dashboard_ui_direction_en.md's contribution
 * ring. Zero total growth returns [] rather than dividing by zero. */
export function deriveChannelContribution(stats: DailyVideoStat[]): ChannelContribution[] {
  const byChannel = new Map<string, { channelName: string; dailyIncrease: number }>()
  for (const s of stats) {
    if (s.status !== "ok") continue
    const existing = byChannel.get(s.channelId)
    if (existing) {
      existing.dailyIncrease += s.dailyIncrease
    } else {
      byChannel.set(s.channelId, { channelName: s.channelName, dailyIncrease: s.dailyIncrease })
    }
  }
  // Net each channel's total across all its videos first, then drop any
  // channel whose net isn't positive — a channel with one +100 and one -30
  // video contributed a net +70, not +100 (which double-counting only the
  // positive video would have overstated).
  for (const [channelId, c] of byChannel) {
    if (c.dailyIncrease <= 0) byChannel.delete(channelId)
  }

  const total = Array.from(byChannel.values()).reduce((sum, c) => sum + c.dailyIncrease, 0)
  if (total <= 0) return []

  return Array.from(byChannel.entries())
    .map(([channelId, c]) => ({
      channelId,
      channelName: c.channelName,
      dailyIncrease: c.dailyIncrease,
      percent: (c.dailyIncrease / total) * 100,
    }))
    .sort((a, b) => b.dailyIncrease - a.dailyIncrease)
}
