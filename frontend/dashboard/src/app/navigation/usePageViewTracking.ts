import { useEffect } from "react"
import { trackRoute } from "../../shared/analytics/analytics"
import { creatorPath, parseCreatorRoute } from "./creatorRoutes"
import type { Page } from "./useCurrentPage"

/** The readable title reported for a measured route. Only "/", "/creator/*" and "/schedule" are ever measured (see isAnalyticsRoute); every
 * other page still reports its route so that collection is switched off while the visitor is there. */
const FIXED_TITLES: Partial<Record<Page, string>> = { schedule: "Schedule", settings: "Settings", about: "About" }

/** Reports every change of URL path to Analytics (the site routes with history.pushState, which Analytics does not see by itself):
 * the root Home as "/", an explicit creator Home under /creator/:slug, and the fixed pages under their own path. What is actually measured is
 * decided in one place, analytics.ts's isAnalyticsRoute. Query-only changes (About/Settings sections) and repeats of the same path do nothing. */
export function usePageViewTracking(page: Page, path: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || page === "dashboard") return
    if (page === "home") {
      const route = parseCreatorRoute(path)
      trackRoute(route?.kind === "creator" ? creatorPath(route.creator) : path, route?.kind === "creator" ? route.creator.displayName : "Home")
      return
    }
    trackRoute(path, FIXED_TITLES[page] ?? page)
  }, [page, path, enabled])
}
