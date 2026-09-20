import { useEffect, useRef, useState } from "react"
import type { ComparisonItem } from "../types/dashboardComparisonCatalog"

/** Loads the backend-supported comparison items once per mounted instance of
 * the page that calls it: one in-flight promise is cached in a ref, so React
 * Strict Mode's mount/cleanup/mount replay reuses it instead of issuing a
 * second request (the same guarantee `useChartCatalog` gives the chart
 * catalog). The list is empty until the items arrive or if the request fails
 * -- Flow 2 then simply has nothing to select and comparison charts request
 * no items. Independent of the chart catalog loader, so it can never add a
 * chart-catalog request. */
export function useComparisonItems(fetchItems: () => Promise<ComparisonItem[]>): ComparisonItem[] {
  const [items, setItems] = useState<ComparisonItem[]>([])
  const requestRef = useRef<Promise<ComparisonItem[]> | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!requestRef.current) requestRef.current = fetchItems()
    requestRef.current.then(
      (loaded) => {
        if (!cancelled) setItems(loaded)
      },
      () => undefined,
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return items
}
