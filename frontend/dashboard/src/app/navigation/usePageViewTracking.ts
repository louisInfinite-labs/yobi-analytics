import { useEffect } from "react"
import { trackPageView } from "../../shared/analytics/analytics"
import type { Page } from "./useCurrentPage"

/** The canonical path and a readable title reported for each page (the real URL can be an unknown path that falls back to Home, and the
 * document title is the same "OshiYobi" everywhere). The development-only Video Data page is never reported. */
const PAGE_VIEW: Partial<Record<Page, { path: string; title: string }>> = {
  home: { path: "/", title: "Home" },
  schedule: { path: "/schedule", title: "Schedule" },
  settings: { path: "/setting", title: "Settings" },
  about: { path: "/about", title: "About" },
}

/** Reports a page view whenever the visible page changes (the site routes with history.pushState, which Analytics does not see by itself). */
export function usePageViewTracking(page: Page, enabled: boolean): void {
  useEffect(() => {
    const view = PAGE_VIEW[page]
    if (enabled && view) trackPageView(view.path, view.title)
  }, [page, enabled])
}
