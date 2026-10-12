import { useEffect } from "react"
import { trackPageView } from "../../shared/analytics/analytics"
import { creatorPath, parseCreatorRoute } from "./creatorRoutes"
import type { Page } from "./useCurrentPage"

/** The readable title reported for each fixed page (the document title is the same "OshiYobi" everywhere). The development-only Video Data page
 * is never reported. Home is reported per creator, under its own /creator/:slug path. */
const FIXED_PAGE_VIEW: Partial<Record<Page, { path: string; title: string }>> = {
  schedule: { path: "/schedule", title: "Schedule" },
  settings: { path: "/setting", title: "Settings" },
  about: { path: "/about", title: "About" },
}

/** Reports one page view for every change of URL path (the site routes with history.pushState, which Analytics does not see by itself):
 * /, /schedule, /setting, /about and each /creator/:slug (selecting a creator on Home is a new path, so it is a new page view). Query-only changes
 * (About/Settings sections) and repeats of the same path are not. */
export function usePageViewTracking(page: Page, path: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    if (page === "home") {
      // The root Home keeps its own "/" (whichever creator it shows -- Analytics does not read the Oshi into the path); an explicit creator
      // Home is reported under /creator/:slug. Any other unknown path that falls back to Home is not reported.
      if (path === "/") return trackPageView("/", "Home")
      const route = parseCreatorRoute(path)
      if (route?.kind === "creator") trackPageView(creatorPath(route.creator), route.creator.displayName)
      return
    }
    const view = FIXED_PAGE_VIEW[page]
    if (view) trackPageView(view.path, view.title)
  }, [page, path, enabled])
}
