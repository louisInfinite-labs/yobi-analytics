/** MT-14 "Comparison Data and Render States"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 3.4
 * "Comparison data"; DASHBOARD_LAYOUT_IMPLEMENTATION_TASKS.md MT-14).
 *
 * Renders one comparison widget's chart: one Recharts `<Line>` per selected
 * creator (AC3), in the same click order the widget's `comparison.creatorIds`
 * already carries (AC4) -- never re-sorted by name or value. Reuses the
 * existing Recharts chart library and tooltip/legend/color conventions
 * `GrowthBarChart.tsx` already established (Guidelines Section 0.1: "Do not
 * introduce another chart library or create a parallel chart abstraction").
 *
 * Takes an explicit pixel `width`/`height` rather than wrapping in
 * `ResponsiveContainer`: every canonical widget already has a fixed pixel
 * box from `computeWidgetPixelRect` (dashboardSpacing.ts) -- the grid is
 * unit-based, not CSS-fluid -- so a caller-supplied pixel size matches that
 * existing box model instead of adding a second, CSS-percentage-driven
 * sizing mechanism.
 *
 * `creators`/`comparisonItemId` are always rendered from directly, never
 * from fetched data, so the loading and error states below keep showing the
 * widget's own configuration even before or after a failed request (AC5,
 * AC7). A response with per-creator issues (`unavailable`/`error`) keeps
 * every still-valid creator's series and lists the affected creators
 * separately (AC6, AC9) -- it never drops the whole chart for one bad
 * creator.
 */
import { useMemo } from "react"
import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts"
import { useComparisonData } from "../hooks/useComparisonData"
import { buildComparisonChartRows } from "../lib/comparisonChartData"
import { MIN_CHART_WIDTH_PX } from "../lib/dashboardResponsive"
import { isOkComparisonResult } from "../types/dashboardComparisonData"
import type { MockCreator } from "../data/mockCreators"
import type { ComparisonDataRequest, ComparisonDataResponse } from "../types/dashboardComparisonData"
import type { ComparisonItem } from "../types/dashboardComparisonCatalog"

const SERIES_COLORS = ["#6366f1", "#14b8a6", "#f59e0b", "#ef4444", "#8b5cf6"]

export interface ComparisonChartProps {
  /** Ordered exactly like click order (MT-10) -- the resulting legend and
   * tooltip series order follows this array's order (AC4). Injected rather
   * than owned here, the same convention `CreatorComparisonPicker` already
   * uses for `creators`. */
  creators: readonly MockCreator[]
  comparisonItemId: string
  /** AC2: the backend-supported comparison-item catalog -- the same
   * `ComparisonItem` contract `ComparisonMappingDialog.tsx`'s
   * `availableComparisonItems` prop already uses. `comparisonItemId` is
   * filtered against this before it ever reaches `fetchComparisonData`. */
  availableComparisonItems: readonly ComparisonItem[]
  width: number
  height: number
  fetchComparisonData: (request: ComparisonDataRequest) => Promise<ComparisonDataResponse>
}

function issueMessage(status: "unavailable" | "error"): string {
  return status === "unavailable" ? "No longer available for comparison." : "Comparison data failed to load for this creator."
}

export function ComparisonChart({ creators, comparisonItemId, availableComparisonItems, width, height, fetchComparisonData }: ComparisonChartProps) {
  const creatorIds = useMemo(() => creators.map((creator) => creator.channelId), [creators])
  const nameByCreatorId = useMemo(() => new Map(creators.map((creator) => [creator.channelId, creator.channelName])), [creators])
  const { state } = useComparisonData(creatorIds, [comparisonItemId], availableComparisonItems, fetchComparisonData)

  if (state.phase === "loading") {
    return (
      <div
        data-testid="comparison-chart-loading"
        className="skeleton"
        role="status"
        aria-label={`Loading comparison for ${creators.map((creator) => creator.channelName).join(", ")}`}
        style={{ width, height }}
      />
    )
  }

  if (state.phase === "error") {
    return (
      <div data-testid="comparison-chart-error" role="alert" style={{ width, height }}>
        <p>Couldn&apos;t load comparison data.</p>
        <span className="sr-only">Comparison configuration preserved for {creators.map((creator) => creator.channelName).join(", ")}.</span>
      </div>
    )
  }

  const { creators: results } = state.response

  if (results.length === 0) {
    return (
      <div data-testid="comparison-chart-empty" style={{ width, height }}>
        No comparison data available.
      </div>
    )
  }

  const okResults = results.filter(isOkComparisonResult)
  const issueResults = results.filter((result) => !isOkComparisonResult(result))
  const rows = buildComparisonChartRows(okResults)

  return (
    <div data-testid="comparison-chart" style={{ width, height }}>
      {issueResults.length > 0 && (
        <ul data-testid="comparison-chart-issues" aria-label="Comparison data issues">
          {issueResults.map((result) => (
            <li key={result.creatorId} data-testid={`comparison-chart-issue-${result.creatorId}`} data-status={result.status}>
              {nameByCreatorId.get(result.creatorId) ?? result.creatorId}: {issueMessage(result.status)}
            </li>
          ))}
        </ul>
      )}
      {okResults.length > 0 &&
        (width < MIN_CHART_WIDTH_PX ? (
          // MT-16 AC5 (Section 11: "rather than shrinking charts below their
          // readable size"): below the documented minimum, the chart itself
          // does not render -- a squished, unreadable chart is worse than no
          // chart. The widget's own configuration/data are still intact
          // (`okResults` above), so widening the box later renders normally.
          <div data-testid="comparison-chart-too-narrow" role="status">
            Widen this widget to view the chart ({width}px, minimum {MIN_CHART_WIDTH_PX}px).
          </div>
        ) : (
          <LineChart width={width} height={height} data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-border)" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={{ stroke: "var(--surface-border)" }} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={false} tickLine={false} width={48} />
            <Tooltip contentStyle={{ borderRadius: 8, borderColor: "var(--surface-border)", fontSize: 12 }} />
            <Legend />
            {okResults.map((result, index) => (
              <Line
                key={result.creatorId}
                dataKey={result.creatorId}
                name={nameByCreatorId.get(result.creatorId) ?? result.creatorId}
                stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        ))}
    </div>
  )
}
