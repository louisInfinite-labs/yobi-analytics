import type { ChartCatalogItem } from "../types/dashboardChartCatalog"

/** GAP-1A "Production Chart Catalog Lifecycle Wiring"
 * (DASHBOARD_LAYOUT_GUIDELINES.md Section 3.2/3.3; GAP-1 as recorded in
 * DASHBOARD_LAYOUT_IMPLEMENTATION_TASKS.md's MT-04 section).
 *
 * `DashboardPage.tsx`'s injected `fetchCatalog` for `useChartCatalog`
 * (../hooks/useChartCatalog.ts) -- the same "injected fetch function"
 * convention `dashboardAnalyticsSource.ts`'s `fetchMockAnalytics` already
 * uses for this same page's analytics stats. No backend chart-catalog
 * endpoint exists yet (GAP-3, still unresolved -- not this microtask's
 * job): this always resolves the same fixed mock list, proving GAP-1's
 * *lifecycle* wiring (mount-once, Edit/Cancel dedup, Strict Mode dedup)
 * without pretending to be a real backend request. Replacing this with a
 * real fetch against an owned endpoint is GAP-3's job.
 */
const MOCK_CHART_CATALOG_ITEMS: ChartCatalogItem[] = [
  { chartDefinitionId: "kpi-summary", title: "KPI Summary" },
  { chartDefinitionId: "growth-bar-chart", title: "Growth Bar Chart" },
  { chartDefinitionId: "contribution-ring", title: "Contribution Ring" },
  { chartDefinitionId: "ranking", title: "Ranking" },
]

export function fetchMockChartCatalog(): Promise<ChartCatalogItem[]> {
  return Promise.resolve([...MOCK_CHART_CATALOG_ITEMS])
}
