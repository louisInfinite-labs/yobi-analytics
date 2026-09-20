import type { ComparisonItem } from "../types/dashboardComparisonCatalog"
import type { ComparisonDataRequest, ComparisonDataResponse } from "../types/dashboardComparisonData"

/** The comparison source boundary the live Dashboard consumes: where
 * backend-supported comparison items and comparison data come from. It is the
 * only place `DashboardPage` reaches for either. `origin` says whether the
 * values are real (`"backend"`) or sample data (`"mock"`, only ever supplied
 * by tests), so the UI can label sample values and never mistake them for real
 * analytics.
 *
 * The production implementation is `backendComparisonSource.ts`. Tests inject
 * their own `ComparisonSource`; there is no hidden switch in production code. */
export interface ComparisonSource {
  origin: "mock" | "backend"
  /** The backend-supported comparison items Flow 2 may offer and requests may carry. */
  loadItems: () => Promise<ComparisonItem[]>
  /** One comparison widget's data for ordered `creatorIds` and item ids. The
   * response lists one result per requested creator, in request order (or no
   * creators at all for the empty state). */
  fetchData: (request: ComparisonDataRequest) => Promise<ComparisonDataResponse>
}
