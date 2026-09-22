import type { ReactNode } from "react"
import type { DailyVideoStat, Period } from "../../../../entities/creator/model/domain"
import type { WidgetDefinition, WidgetTypeId } from "../model/widget"
import { ContributionBarChart } from "../../../analytics/charts/ContributionBarChart"
import { CreatorAvatar } from "../../../analytics/charts/CreatorAvatar"
import { GrowthBarChart, type GrowthBarChartPoint } from "../../../analytics/charts/GrowthBarChart"
import { InsightCard } from "../../../analytics/charts/InsightCard"
import { KpiCard } from "../../../analytics/charts/KpiCard"
import { RankingCard } from "../../../analytics/charts/RankingCard"
import { VideoStatsTable } from "../../../analytics/charts/VideoStatsTable"
import type { DashboardKpis, ChannelContribution } from "../../../analytics/utils/deriveAnalytics"
import { WIDGET_ALLOWED_HEIGHTS } from "./widgetHeightCapabilities"

/** Every value a widget's renderer might need, already computed once by DashboardPage
 * and threaded through unchanged — Phase 7 wraps *placement*, not data computation. */
export interface DashboardWidgetData {
  kpis: DashboardKpis
  contributions: ChannelContribution[]
  filteredStats: DailyVideoStat[]
  insights: string[]
  byDay: GrowthBarChartPoint[]
  byChannel: GrowthBarChartPoint[]
  period: Period
  timeZone: string
}

interface WidgetRegistryEntry {
  definition: WidgetDefinition
  render: (data: DashboardWidgetData) => ReactNode
}

const KPI_SUMMARY: WidgetRegistryEntry = {
  definition: {
    type: "kpi-summary",
    schemaVersion: 1,
    title: "KPI Summary",
    description: "Total views, daily gain, and top performer.",
    sizeLimits: { minW: 4, minH: 1, defaultW: 12, defaultH: 1 },
    allowedHeights: WIDGET_ALLOWED_HEIGHTS["kpi-summary"],
    permissions: [],
    supportsCreatorScope: false,
    defaultSettings: {},
  },
  render: ({ kpis }) => (
    <div className="card kpi-summary-grid">
      <KpiCard
        label="Top Performer"
        value={kpis.topPerformer ? (
          <span className="kpi-card__creator">
            <CreatorAvatar channelId={kpis.topPerformer.channelId} channelName={kpis.topPerformer.channelName} size="medium" />
            <span>{kpis.topPerformer.channelName}</span>
          </span>
        ) : "—"}
        formatAsCompactNumber={false}
        sub={kpis.topPerformer ? <span className="kpi-card__performer">{kpis.topPerformer.videoTitle}</span> : undefined}
      />
      <KpiCard label="Total Views" value={kpis.totalViews} />
      <KpiCard label="Daily Gain" value={kpis.totalDailyIncrease} />
    </div>
  ),
}

const GROWTH_BAR_CHART: WidgetRegistryEntry = {
  definition: {
    type: "growth-bar-chart",
    schemaVersion: 1,
    title: "Growth Bar Chart",
    description: "View growth by day or by channel.",
    sizeLimits: { minW: 4, minH: 3, defaultW: 8, defaultH: 4 },
    allowedHeights: WIDGET_ALLOWED_HEIGHTS["growth-bar-chart"],
    permissions: [],
    supportsCreatorScope: true,
    defaultSettings: {},
  },
  render: ({ byDay, byChannel }) => (
    <div className="card" style={{ height: "100%" }}>
      <GrowthBarChart byDay={byDay} byChannel={byChannel} />
    </div>
  ),
}

const CONTRIBUTION_RING: WidgetRegistryEntry = {
  definition: {
    type: "contribution-ring",
    schemaVersion: 1,
    title: "Channel Contribution",
    description: "Each channel's share of total growth, as an animated ring.",
    sizeLimits: { minW: 3, minH: 3, defaultW: 4, defaultH: 4 },
    allowedHeights: WIDGET_ALLOWED_HEIGHTS["contribution-ring"],
    permissions: [],
    supportsCreatorScope: true,
    defaultSettings: {},
  },
  render: ({ contributions, period }) => <ContributionBarChart contributions={contributions} period={period} />,
}

const RANKING: WidgetRegistryEntry = {
  definition: {
    type: "ranking",
    schemaVersion: 1,
    title: "Rankings",
    description: "Top-growing videos and channels.",
    sizeLimits: { minW: 3, minH: 3, defaultW: 4, defaultH: 4 },
    allowedHeights: WIDGET_ALLOWED_HEIGHTS["ranking"],
    permissions: [],
    supportsCreatorScope: true,
    defaultSettings: {},
  },
  render: ({ filteredStats }) => <RankingCard stats={filteredStats} />,
}

const INSIGHTS: WidgetRegistryEntry = {
  definition: {
    type: "insights",
    schemaVersion: 1,
    title: "Insights",
    description: "Short, data-focused observations about the current view.",
    sizeLimits: { minW: 4, minH: 1, defaultW: 12, defaultH: 1 },
    allowedHeights: WIDGET_ALLOWED_HEIGHTS["insights"],
    permissions: [],
    supportsCreatorScope: false,
    defaultSettings: {},
  },
  render: ({ insights }) =>
    insights.length === 0 ? (
      <InsightCard text="Not enough data yet for an insight in this view." />
    ) : (
      <>
        {insights.map((text, i) => (
          <InsightCard key={i} text={text} />
        ))}
      </>
    ),
}

const VIDEO_STATS_TABLE: WidgetRegistryEntry = {
  definition: {
    type: "video-stats-table",
    schemaVersion: 1,
    title: "Video Stats Table",
    description: "Detailed per-video statistics with search, filters, sorting, and pagination.",
    sizeLimits: { minW: 6, minH: 4, defaultW: 12, defaultH: 6 },
    allowedHeights: WIDGET_ALLOWED_HEIGHTS["video-stats-table"],
    permissions: [],
    supportsCreatorScope: true,
    defaultSettings: {},
  },
  render: ({ filteredStats, timeZone }) => <VideoStatsTable stats={filteredStats} timeZone={timeZone} />,
}

export const WIDGET_REGISTRY: Record<WidgetTypeId, WidgetRegistryEntry> = {
  "kpi-summary": KPI_SUMMARY,
  "growth-bar-chart": GROWTH_BAR_CHART,
  "contribution-ring": CONTRIBUTION_RING,
  ranking: RANKING,
  insights: INSIGHTS,
  "video-stats-table": VIDEO_STATS_TABLE,
}

export function getWidgetDefinition(type: WidgetTypeId): WidgetDefinition {
  return WIDGET_REGISTRY[type].definition
}

export function renderWidget(type: WidgetTypeId, data: DashboardWidgetData): ReactNode {
  return WIDGET_REGISTRY[type].render(data)
}

export function supportsCreatorScope(type: string): boolean {
  return isKnownWidgetType(type) && WIDGET_REGISTRY[type].definition.supportsCreatorScope
}

export const ALL_WIDGET_TYPES = Object.keys(WIDGET_REGISTRY) as WidgetTypeId[]

/** Guards a persisted layout's widget.type before it reaches getWidgetDefinition/
 * renderWidget, which index WIDGET_REGISTRY directly and would throw on an
 * unregistered type (e.g. a retired widget from an older layoutVersion). */
export function isKnownWidgetType(type: string): type is WidgetTypeId {
  return Object.hasOwn(WIDGET_REGISTRY, type)
}
