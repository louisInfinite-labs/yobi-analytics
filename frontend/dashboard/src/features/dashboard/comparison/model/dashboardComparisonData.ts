/** MT-14 "Comparison Data and Render States"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 3.4
 * "Comparison data"; DASHBOARD_LAYOUT_IMPLEMENTATION_TASKS.md MT-14).
 *
 * The fetch contract for a comparison widget's chart data. Mirrors
 * `CreatorComparisonConfig` (../types/dashboardLayout.ts) rather than
 * inventing a parallel shape: `creatorIds`/`comparisonItemIds` stay ordered
 * and array-typed here for the same reason that type documents ("ordered,
 * unique"). No backend comparison-data endpoint exists in this repository
 * (the same GAP-3-shaped gap DASHBOARD_LAYOUT_IMPLEMENTATION_TASKS.md
 * already records for the chart catalog), so `fetchComparisonData` is the
 * same injected-boundary pattern `useCachedDashboardData`'s `fetchFn` and
 * `useChartCatalog`'s `fetchCatalog` already use.
 */

export interface ComparisonSeriesPoint {
  label: string
  value: number
}

/** One creator's result within a comparison response. `unavailable` is a
 * creator that was previously selected but the backend can no longer serve
 * (Section 3.4: "If a previously selected creator becomes unavailable, show
 * an actionable unavailable state and preserve the remaining valid
 * selections"). `error` is a creator whose data failed to load while other
 * creators in the same response succeeded (Section 3.4's "partial-error
 * state identifies the failed creator/item without deleting valid data").
 * Neither variant carries fabricated points. */
export type ComparisonCreatorResult =
  | { status: "ok"; creatorId: string; points: ComparisonSeriesPoint[] }
  | { status: "unavailable"; creatorId: string }
  | { status: "error"; creatorId: string }

export interface ComparisonDataRequest {
  creatorIds: string[] // ordered, deduplicated
  comparisonItemIds: string[] // ordered, deduplicated
}

export interface ComparisonDataResponse {
  creators: ComparisonCreatorResult[] // one entry per requested creatorId, ordered to match the request
}

export function isOkComparisonResult(result: ComparisonCreatorResult): result is Extract<ComparisonCreatorResult, { status: "ok" }> {
  return result.status === "ok"
}
