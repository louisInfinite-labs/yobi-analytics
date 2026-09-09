import { useCallback, useMemo, useState } from "react"
import { mockDailySeries } from "../../data/mockDailySeries"
import { useCachedDashboardData } from "../../hooks/useCachedDashboardData"
import { deriveChannelContribution, deriveKpis } from "../../lib/deriveAnalytics"
import { fetchMockAnalytics, MOCK_REPORT_DATE } from "../../lib/dashboardAnalyticsSource"
import { detectDeviceTimeZone } from "../../lib/timezone"
import { getMemberAccent } from "../../theme/memberAccent"
import type { Period } from "../../types/domain"
import { GrowthBarChart } from "../GrowthBarChart"
import { KpiCard } from "../KpiCard"
import { LoadingState } from "../states/LoadingState"
import { ErrorState } from "../states/ErrorState"
import { describeApiFailure } from "../../lib/apiClient"

interface HomeAnalyticsOverlayProps {
  creatorId: string
}

const PERIOD: Period = "1d"

/** Layer 5: a compact OBS-style analytics panel. Reuses the exact same
 * fetch pipeline and derive/chart logic as the Dashboard (spec: "chart
 * calculations and fetching remain shared") — only size/styling here are
 * Home-specific. */
export function HomeAnalyticsOverlay({ creatorId }: HomeAnalyticsOverlayProps) {
  const [timeZone] = useState(detectDeviceTimeZone)
  const fetchFn = useCallback(
    () => fetchMockAnalytics(MOCK_REPORT_DATE, PERIOD).then((entry) => ({ ...entry, timeZone })),
    [timeZone],
  )
  const { entry, loading, error } = useCachedDashboardData(
    { timeZone, reportDate: MOCK_REPORT_DATE, period: PERIOD, dataSource: "mock" },
    fetchFn,
  )

  const allStats = useMemo(() => entry?.results ?? [], [entry])
  const kpis = useMemo(() => deriveKpis(allStats), [allStats])
  const contributions = useMemo(() => deriveChannelContribution(allStats), [allStats])
  const byChannel = useMemo(
    () => contributions.slice(0, 5).map((c) => ({ label: c.channelName, value: c.dailyIncrease })),
    [contributions],
  )
  const byDay = useMemo(() => {
    const allTimeTotal = allStats.filter((s) => s.status === "ok").reduce((sum, s) => sum + s.dailyIncrease, 0)
    const ratio = allTimeTotal > 0 ? kpis.totalDailyIncrease / allTimeTotal : 0
    return mockDailySeries.slice(-7).map((p) => ({ label: p.date.slice(5), value: Math.round(p.dailyIncrease * ratio) }))
  }, [allStats, kpis.totalDailyIncrease])

  const accent = getMemberAccent(creatorId)

  return (
    <div
      className="home-scene__layer home-analytics-overlay"
      style={{ "--home-overlay-accent": accent.primary } as React.CSSProperties}
    >
      {loading ? (
        <LoadingState rows={2} />
      ) : error && entry === null ? (
        (() => {
          const { code, description } = describeApiFailure(error)
          return <ErrorState message={description} code={code} />
        })()
      ) : (
        <>
          <div className="home-analytics-overlay__kpis">
            <KpiCard label="Views" value={kpis.totalViews} />
            <KpiCard label="Daily Gain" value={kpis.totalDailyIncrease} />
          </div>
          <div className="home-analytics-overlay__chart">
            <GrowthBarChart byDay={byDay} byChannel={byChannel} />
          </div>
        </>
      )}
    </div>
  )
}
