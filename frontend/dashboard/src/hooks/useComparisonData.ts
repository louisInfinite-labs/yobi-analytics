/** MT-14 "Comparison Data and Render States" (Section 3.4 "Comparison data").
 *
 * Fetches one comparison widget's chart data for an ordered set of
 * `creatorIds`/`comparisonItemIds`, the same request-shape/loading-state
 * convention `useCachedDashboardData.ts` and `useChartCatalog.ts` already
 * use for their own injected `fetchFn`. Deliberately keeps the request
 * "configuration" (creator/item ids) and the async "result" separate: the
 * caller always has the configuration it asked for available from `request`
 * regardless of `state.phase`, so a loading or failed fetch can never erase
 * the widget's own comparison configuration (AC5, AC7).
 */
import { useEffect, useState } from "react"
import { dedupePreservingOrder } from "../lib/creatorComparisonOrder"
import type { ComparisonDataRequest, ComparisonDataResponse } from "../types/dashboardComparisonData"
import type { ComparisonItem } from "../types/dashboardComparisonCatalog"

export type ComparisonLoadState = { phase: "loading" } | { phase: "error"; error: Error } | { phase: "success"; response: ComparisonDataResponse }

export interface UseComparisonDataResult {
  state: ComparisonLoadState
  request: ComparisonDataRequest
}

/** AC1: ordered and deduplicated, mirroring `CreatorComparisonConfig`'s own
 * "ordered, unique" contract rather than trusting the caller to have already
 * deduplicated.
 *
 * AC2: `comparisonItemIds` is additionally filtered to only the ids present
 * in `availableComparisonItems` -- the same backend-supported catalog
 * contract `ComparisonMappingDialog.tsx`'s `availableComparisonItems` prop
 * already uses (`ComparisonItem`, ../types/dashboardComparisonCatalog.ts) --
 * so an id that isn't backend-supported can never reach the outgoing
 * request, rather than trusting every caller to have already filtered it. */
export function buildComparisonDataRequest(
  creatorIds: readonly string[],
  comparisonItemIds: readonly string[],
  availableComparisonItems: readonly ComparisonItem[],
): ComparisonDataRequest {
  const supportedItemIds = new Set(availableComparisonItems.map((item) => item.comparisonItemId))
  return {
    creatorIds: dedupePreservingOrder(creatorIds),
    comparisonItemIds: dedupePreservingOrder(comparisonItemIds.filter((id) => supportedItemIds.has(id))),
  }
}

export function useComparisonData(
  creatorIds: readonly string[],
  comparisonItemIds: readonly string[],
  availableComparisonItems: readonly ComparisonItem[],
  fetchComparisonData: (request: ComparisonDataRequest) => Promise<ComparisonDataResponse>,
): UseComparisonDataResult {
  const request = buildComparisonDataRequest(creatorIds, comparisonItemIds, availableComparisonItems)
  const requestSignature = `${request.creatorIds.join(",")}::${request.comparisonItemIds.join(",")}`

  const [state, setState] = useState<ComparisonLoadState>({ phase: "loading" })
  // Same synchronous-during-render resync `useCachedDashboardData` uses when
  // its key changes: an effect only runs after this render has already
  // committed, which would show the previous request's stale result for one
  // frame before correcting itself.
  const [lastSignature, setLastSignature] = useState(requestSignature)
  if (requestSignature !== lastSignature) {
    setLastSignature(requestSignature)
    setState({ phase: "loading" })
  }

  useEffect(() => {
    let cancelled = false

    fetchComparisonData(request)
      .then((response) => {
        if (cancelled) return
        setState({ phase: "success", response })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({ phase: "error", error: err instanceof Error ? err : new Error(String(err)) })
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestSignature])

  return { state, request }
}
