import { useCallback, useMemo, useState } from "react"
import { MOCK_REPORT_DATE, mockVideoStats } from "../data/mockVideoStats"
import { mockDailySeries } from "../data/mockDailySeries"
import type { CacheEntry } from "../lib/analyticsCache"
import { useBreakpoint } from "../hooks/useBreakpoint"
import { useCachedDashboardData } from "../hooks/useCachedDashboardData"
import { useEditableLayout } from "../hooks/useEditableLayout"
import { useFilterState } from "../hooks/useFilterState"
import { useHeartbeat } from "../hooks/useHeartbeat"
import { deriveChannelContribution, deriveKpis } from "../lib/deriveAnalytics"
import { deriveInsights } from "../lib/deriveInsights"
import { matchesClassification, matchesContent } from "../lib/filterState"
import { fetchLiveAnalytics } from "../lib/liveAnalytics"
import { comparisonDateFor, scaleStatsForPeriod } from "../lib/period"
import { detectDeviceTimeZone } from "../lib/timezone"
import type { Period } from "../types/domain"
import type { DashboardWidgetData } from "../lib/widgetRegistry"
import { ClassificationFilterBar } from "./filters/ClassificationFilterBar"
import { useDataSource } from "./DataSourceToggle"
import { DashboardFooter } from "./DashboardFooter"
import { DashboardGrid } from "./DashboardGrid"
import { DashboardHeader } from "./DashboardHeader"
import { EditModeToolbar } from "./EditModeToolbar"
import { SaveToast } from "./SaveToast"
import { StaleDataNotice } from "./StaleDataNotice"
import { WidgetTray } from "./WidgetTray"
import { EmptyState } from "./states/EmptyState"
import { ErrorState } from "./states/ErrorState"
import { LoadingState } from "./states/LoadingState"

const LAYOUT_PROFILE_ID = "default"

/** Mock fixture path (Roadmap 3.6's cache-then-refresh flow, real not simulated). */
function fetchMockAnalytics(reportDate: string, period: Period): Promise<CacheEntry> {
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

/** Real Read API path (Roadmap 3.4) — merges every organization's trending
 * results (see lib/liveAnalytics.ts for why this is more than one request)
 * into the same CacheEntry shape the mock path returns, so nothing
 * downstream of fetchAnalytics needs to know which source it came from. */
async function fetchRealAnalytics(reportDate: string, period: Period, timeZone: string): Promise<CacheEntry> {
  const { results, comparisonDate } = await fetchLiveAnalytics(reportDate, period, timeZone)
  return {
    timeZone: "",
    reportDate,
    comparisonDate,
    period,
    fetchedAt: new Date().toISOString(),
    results,
  }
}

/** Top-level composition: wires cache-backed data, filters, and every
 * KPI/chart/ranking/table view together behind one shared filter state. */
export function DashboardPage() {
  useHeartbeat()
  const [period, setPeriod] = useState<Period>("1d")
  const [timeZone, setTimeZone] = useState(detectDeviceTimeZone)
  const filters = useFilterState()
  const [dataSource, setDataSource] = useDataSource()
  const breakpoint = useBreakpoint()
  const {
    layout,
    editMode,
    isDirty,
    saveConfirmation,
    enterEditMode,
    cancelEditMode,
    save,
    resetToDefault,
    updateWidgetPositions,
    addWidget,
    removeWidget,
  } = useEditableLayout(LAYOUT_PROFILE_ID, breakpoint)

  const fetchFn = useCallback(() => {
    const fetchPromise =
      dataSource === "live"
        ? fetchRealAnalytics(MOCK_REPORT_DATE, period, timeZone)
        : fetchMockAnalytics(MOCK_REPORT_DATE, period)
    return fetchPromise.then((entry) => ({ ...entry, timeZone }))
  }, [period, timeZone, dataSource])
  const { entry, loading, error } = useCachedDashboardData(
    { timeZone, reportDate: MOCK_REPORT_DATE, period, dataSource },
    fetchFn,
  )

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

  const widgetData: DashboardWidgetData = {
    kpis,
    contributions,
    filteredStats,
    insights,
    byDay,
    byChannel,
    period,
    timeZone,
  }

  return (
    <div className="dashboard-page">
      <DashboardHeader
        lastUpdatedAt={lastUpdatedAt}
        timeZone={timeZone}
        onTimeZoneChange={setTimeZone}
        period={period}
        onPeriodChange={setPeriod}
        dataSource={dataSource}
        onDataSourceChange={setDataSource}
      />

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
        <>
          <div className="dashboard-page__toolbar">
            <EditModeToolbar
              editMode={editMode}
              isDirty={isDirty}
              onEnterEditMode={enterEditMode}
              onSave={save}
              onCancel={cancelEditMode}
              onResetToDefault={resetToDefault}
            />
          </div>

          {editMode && <WidgetTray onAddWidget={addWidget} />}

          <DashboardGrid
            widgets={layout.widgets}
            editable={editMode}
            data={widgetData}
            onPositionsChange={updateWidgetPositions}
            onRemoveWidget={removeWidget}
          />

          <StaleDataNotice lastUpdatedAt={lastUpdatedAt} />
        </>
      )}

      <SaveToast visible={saveConfirmation} />
      <DashboardFooter />
    </div>
  )
}
