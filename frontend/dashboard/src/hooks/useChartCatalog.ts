/** MT-04 "Chart Catalog Single-Load Behavior"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 3.3).
 *
 * Loads the chart catalog once per mounted instance of this hook and reuses
 * that result for every consumer (view mode, repeated Edit toggles) without
 * a second request. `fetchCatalog` is injected -- the same pattern
 * `useCachedDashboardData` (../features/analytics/hooks/useCachedDashboardData.ts)
 * already uses for its `fetchFn` -- so this hook doesn't know or care
 * whether it's backed by a real backend endpoint or a fixture; there is no
 * chart catalog backend endpoint in this repository yet, and wiring one is
 * out of MT-04's scope.
 *
 * A single request-in-flight promise, cached in a ref across the whole
 * component lifetime, is what keeps repeated effect invocations (React
 * Strict Mode's mount/cleanup/mount double-invoke, or any unrelated
 * re-render) from issuing a second request: every invocation before
 * `retry()` reuses that same promise instance instead of calling
 * `fetchCatalog` again.
 *
 * IMPORTANT for whoever wires this into the production editor (MT-07
 * onward): this guarantee is per *mounted instance*, not per Dashboard page
 * automatically. A `useRef` does not survive an unmount/remount -- calling
 * this hook from a component that itself unmounts when Edit is toggled off
 * (e.g. the legacy `WidgetTray`'s current `{editMode && <WidgetTray ... />}`
 * pattern in `DashboardPage.tsx`) would issue a fresh request every time
 * Edit is re-entered, violating Section 3.3 rule 4/5 despite this hook
 * behaving exactly as designed. To get "one request per Dashboard page
 * lifecycle" in production, mount this hook in a component that persists
 * across the whole edit/view lifecycle (e.g. `DashboardPage` itself) and
 * pass its `state`/`retry` down, rather than calling it from inside a
 * conditionally-rendered picker.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { ChartCatalogItem } from "../types/dashboardChartCatalog"

export type ChartCatalogState =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "success"; items: ChartCatalogItem[] }

export interface UseChartCatalogResult {
  state: ChartCatalogState
  /** Issues exactly one additional request, replacing whatever request is
   * currently cached (Section 3.3: "A new request is allowed only after an
   * explicit refresh/retry..."). */
  retry: () => void
}

export function useChartCatalog(fetchCatalog: () => Promise<ChartCatalogItem[]>): UseChartCatalogResult {
  const [state, setState] = useState<ChartCatalogState>({ status: "loading" })
  const [retryToken, setRetryToken] = useState(0)
  const requestRef = useRef<Promise<ChartCatalogItem[]> | null>(null)

  useEffect(() => {
    let cancelled = false

    if (!requestRef.current) {
      requestRef.current = fetchCatalog()
    }
    // A retry from the error state must show loading again; a Strict Mode
    // replay of an already-succeeded mount must not flash loading over
    // data that's already on screen.
    setState((current) => (current.status === "success" ? current : { status: "loading" }))

    requestRef.current.then(
      (items) => {
        if (!cancelled) setState({ status: "success", items })
      },
      (err: unknown) => {
        if (!cancelled) setState({ status: "error", error: err instanceof Error ? err : new Error(String(err)) })
      },
    )

    return () => {
      cancelled = true
    }
    // Intentionally keyed only on retryToken: a new fetchCatalog identity
    // (e.g. from a parent re-render) must not by itself trigger a reload --
    // only an explicit retry() may start a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryToken])

  const retry = useCallback(() => {
    requestRef.current = null
    setRetryToken((token) => token + 1)
  }, [])

  return { state, retry }
}
