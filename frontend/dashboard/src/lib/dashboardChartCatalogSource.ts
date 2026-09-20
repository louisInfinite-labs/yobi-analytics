import { apiRequest } from "./apiClient"
import type { ChartCatalogItem } from "../types/dashboardChartCatalog"

/** The production chart-catalog fetcher: `GET /dashboard/chart-catalog` on the
 * real backend (src/dashboard_catalog_api.py), the single source of truth for
 * which charts the Add UI may offer (Guidelines Section 3.2: "Do not maintain
 * a separate hard-coded frontend list"). Injected into `useChartCatalog`
 * exactly like `useCachedDashboardData`'s `fetchFn`, so that hook's
 * one-request-per-page-lifecycle behavior is unchanged. */
export async function fetchChartCatalog(): Promise<ChartCatalogItem[]> {
  const response = await apiRequest<{ charts: ChartCatalogItem[] }>("/dashboard/chart-catalog")
  return response.charts
}
