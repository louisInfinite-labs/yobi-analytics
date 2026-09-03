import type { DailyVideoStat, Period } from "../types/domain"

const PERIOD_DAYS: Record<Period, number> = { "1d": 1, "7d": 7, "30d": 30 }

/** report_date minus period's day count — pure calendar-date arithmetic,
 * mirroring src/view_growth_analytics.py's comparison_date (Roadmap 3.1):
 * no UTC round-trip, so it's correct across a DST transition. */
export function comparisonDateFor(reportDate: string, period: Period): string {
  const [y, m, d] = reportDate.split("-").map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() - PERIOD_DAYS[period])
  return date.toISOString().slice(0, 10)
}

// Sub-linear growth multipliers relative to the mock fixture's 1d value —
// real cumulative growth over a longer window compounds/decays, it doesn't
// scale by a flat day count (7 days of growth is not exactly 7x one day's).
// Mock-only approximation: the real Roadmap 3.4 Read API returns an actual
// period-specific calculate_growth() result per video, not a scaled
// derivative of another period's value — this only exists because the
// frontend-only mock fixture (Roadmap 3.5) carries one growth value per
// video and needs *some* period-selector behavior to demo against.
const PERIOD_SCALE: Record<Period, number> = { "1d": 1, "7d": 5.5, "30d": 15 }

/** Return `stats` with dailyIncrease/growthPercent scaled for `period`, so
 * switching the period selector visibly changes what's displayed (Roadmap
 * 3.4's period=1d|7d|30d contract) instead of silently reusing the 1d
 * fixture value for every period. totalViews/status/etc are untouched —
 * only the period-relative growth figures are period-dependent. */
export function scaleStatsForPeriod(stats: DailyVideoStat[], period: Period): DailyVideoStat[] {
  const scale = PERIOD_SCALE[period]
  if (scale === 1) return stats
  return stats.map((s) =>
    s.status !== "ok"
      ? s
      : {
          ...s,
          dailyIncrease: Math.round(s.dailyIncrease * scale),
          growthPercent: s.growthPercent === null ? null : Math.round(s.growthPercent * scale * 10) / 10,
        },
  )
}
