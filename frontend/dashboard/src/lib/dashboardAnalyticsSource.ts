import type { CacheEntry } from "./analyticsCache"
import { mockVideoStats, MOCK_REPORT_DATE } from "../data/mockVideoStats"
import { fetchLiveAnalytics } from "./liveAnalytics"
import { comparisonDateFor, scaleStatsForPeriod } from "./period"
import type { Period } from "../types/domain"

export { MOCK_REPORT_DATE }

/** Mock fixture path (Roadmap 3.6's cache-then-refresh flow, real not
 * simulated). Shared by DashboardPage and Home's analytics overlay so
 * both read the same fetch pipeline (spec: "Do not add a second fetch
 * pipeline or duplicate chart implementation"). */
export function fetchMockAnalytics(reportDate: string, period: Period): Promise<CacheEntry> {
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
 * results into the same CacheEntry shape the mock path returns, so nothing
 * downstream needs to know which source it came from. */
export async function fetchRealAnalytics(reportDate: string, period: Period, timeZone: string): Promise<CacheEntry> {
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
