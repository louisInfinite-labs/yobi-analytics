import { useCallback, useMemo, useState } from "react"
import { MOCK_REPORT_DATE, mockVideoStats } from "../data/mockVideoStats"
import { mockDailySeries } from "../data/mockDailySeries"
import type { CacheEntry } from "../lib/analyticsCache"
import { useCachedDashboardData } from "../hooks/useCachedDashboardData"
import { useFilterState } from "../hooks/useFilterState"
import { deriveChannelContribution, deriveKpis } from "../lib/deriveAnalytics"
import { deriveInsights } from "../lib/deriveInsights"
import { matchesClassification, matchesContent } from "../lib/filterState"
import { comparisonDateFor, scaleStatsForPeriod } from "../lib/period"
import { detectDeviceTimeZone } from "../lib/timezone"
import type { Period } from "../types/domain"
import { AnimatedRingChart } from "./AnimatedRingChart"
import { ClassificationFilterBar } from "./filters/ClassificationFilterBar"
import { DashboardHeader } from "./DashboardHeader"
import { GrowthBarChart } from "./GrowthBarChart"
import { InsightCard } from "./InsightCard"
import { KpiCard } from "./KpiCard"
import { RankingCard } from "./RankingCard"
import { StaleDataNotice } from "./StaleDataNotice"
import { VideoStatsTable } from "./VideoStatsTable"
import { EmptyState } from "./states/EmptyState"
import { ErrorState } from "./states/ErrorState"
import { LoadingState } from "./states/LoadingState"

/**
 * Stands in for the future Roadmap 3.4 Read API call — currently resolves
 * the mock fixture after a short delay so the cache-then-refresh flow
 * (Roadmap 3.6) is real, not simulated away. Swapping this for an actual
 * fetch() is the only change 3.4's wiring needs to make here — a real
 * Read API call already returns period-specific growth values directly, so
 * scaleStatsForPeriod (a mock-only stand-in for that) goes away too, not
 * just this setTimeout.
 */
function fetchAnalytics(reportDate: string, period: Period): Promise<CacheEntry> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        timeZone: "", // filled in by the caller, which knows the requested zone
        reportDate,
        comparisonDate: comparisonDateFor(reportDate, period),
        period,
        fetchedAt: new Date().toISOString(),
        results: scaleStatsForPeriod(mockVideoStats, period),
      })
    }, 550)
  })
}

/** Top-level composition: wires cache-backed data, filters, and every
 * KPI/chart/ranking/table view together behind one shared filter state. */
export function DashboardPage() {
  const [period, setPeriod] = useState<Period>("1d")
  const [timeZone, setTimeZone] = useState(detectDeviceTimeZone)
  const filters = useFilterState()

  const fetchFn = useCallback(
    () => fetchAnalytics(MOCK_REPORT_DATE, period).then((entry) => ({ ...entry, timeZone })),
    [period, timeZone],
  )
  const { entry, loading, error } = useCachedDashboardData({ timeZone, reportDate: MOCK_REPORT_DATE, period }, fetchFn)

  const allStats = useMemo(() => entry?.results ?? [], [entry])
  const filteredStats = useMemo(
    () => allStats.filter((s) => matchesClassification(s, filters.state) && matchesContent(s, filters.state)),
    [allStats, filters.state],
  )

  const kpis = useMemo(() => deriveKpis(filteredStats), [filteredStats])
  const contributions = useMemo(() => deriveChannelContribution(filteredStats), [filteredStats])
  const insights = useMemo(() => deriveInsights(filteredStats, period), [filteredStats, period])

  const byChannel = useMemo(
    () => contributions.slice(0, 8).map((c) => ({ label: c.channelName, value: c.dailyIncrease })),
    [contributions],
  )
  const byDay = useMemo(() => {
    const allTimeTotal = allStats.filter((s) => s.status === "ok").reduce((sum, s) => sum + s.dailyIncrease, 0)
    const ratio = allTimeTotal > 0 ? kpis.totalDailyIncrease / allTimeTotal : 0
    return mockDailySeries.map((p) => ({ label: p.date.slice(5), value: Math.round(p.dailyIncrease * ratio) }))
  }, [allStats, kpis.totalDailyIncrease])

  const lastUpdatedAt =
    filteredStats.reduce((latest, s) => (s.collectedAt > latest ? s.collectedAt : latest), filteredStats[0]?.collectedAt ?? "") ||
    entry?.fetchedAt ||
    new Date().toISOString()

  return (
    <div className="dashboard-page">
      <DashboardHeader lastUpdatedAt={lastUpdatedAt} timeZone={timeZone} onTimeZoneChange={setTimeZone} period={period} onPeriodChange={setPeriod} />

      <ClassificationFilterBar
        state={filters.state}
        onOrganizationChange={filters.setOrganization}
        onBranchChange={filters.setBranch}
        onGroupKeyToggle={filters.toggleGroupKey}
        onChannelTypeChange={filters.setChannelType}
        onLifecycleStageChange={filters.setLifecycleStage}
        onContentTagToggle={filters.toggleContentTag}
        onContentFormatChange={filters.setContentFormat}
      />

      {loading ? (
        <div className="card">
          <LoadingState rows={4} />
        </div>
      ) : error && entry === null ? (
        <div className="card">
          <ErrorState message="Could not load analytics data." />
        </div>
      ) : filteredStats.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="dashboard-grid">
          <div className="dashboard-grid__kpis">
            <KpiCard label="Total Views" value={kpis.totalViews} />
            <KpiCard label="Daily Gain" value={kpis.totalDailyIncrease} />
            <KpiCard
              label="Average Growth Rate"
              value={kpis.averageGrowthPercent !== null ? `${kpis.averageGrowthPercent.toFixed(1)}%` : "N/A"}
              formatAsCompactNumber={false}
            />
            <KpiCard
              label="Top Performer"
              value={kpis.topPerformer ? kpis.topPerformer.channelName : "—"}
              formatAsCompactNumber={false}
              sub={kpis.topPerformer ? <span className="kpi-card__performer">{kpis.topPerformer.videoTitle}</span> : undefined}
            />
          </div>

          <div className="dashboard-grid__chart">
            <div className="card" style={{ height: "100%" }}>
              <GrowthBarChart byDay={byDay} byChannel={byChannel} />
            </div>
          </div>

          <div className="dashboard-grid__side">
            <AnimatedRingChart contributions={contributions} period={period} />
            <RankingCard stats={filteredStats} />
          </div>

          <div className="dashboard-grid__insights">
            {insights.length === 0 ? (
              <InsightCard text="Not enough data yet for an insight in this view." />
            ) : (
              insights.map((text, i) => <InsightCard key={i} text={text} />)
            )}
          </div>

          <div className="dashboard-grid__table">
            <VideoStatsTable stats={filteredStats} timeZone={timeZone} />
          </div>

          <StaleDataNotice lastUpdatedAt={lastUpdatedAt} />
        </div>
      )}
    </div>
  )
}
