import { useEffect } from "react"
import { trackRoute } from "../../shared/analytics/analytics"
import type { Page } from "./useCurrentPage"

/** The readable title reported for a measured route. Only "/" and "/schedule" are ever measured (see isAnalyticsRoute); every
 * other page still reports its route so that collection is switched off while the visitor is there. */
const FIXED_TITLES: Partial<Record<Page, string>> = { schedule: "Schedule", settings: "Settings", about: "About" }

/** Reports every change of URL path to Analytics (the site routes with history.pushState, which Analytics does not see by itself):
 * Home under its path ("/"; an unknown path, answered with a 404 page, reports its own path and is not measured), and the fixed pages under their own path. What is actually measured is
 * decided in one place, analytics.ts's isAnalyticsRoute. Query-only changes (About/Settings sections) and repeats of the same path do nothing. */
export function usePageViewTracking(page: Page, path: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || page === "dashboard") return
    if (page === "home") {
      trackRoute(path, "Home")
      return
    }
    trackRoute(path, FIXED_TITLES[page] ?? page)
  }, [page, path, enabled])
}
