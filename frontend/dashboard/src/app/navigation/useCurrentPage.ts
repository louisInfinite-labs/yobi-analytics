import { useCallback, useSyncExternalStore } from "react"

export type Page = "home" | "dashboard" | "settings" | "schedule"

const PAGE_PATHS: Record<Page, string> = {
  home: "/",
  dashboard: "/dashboard",
  settings: "/setting",
  schedule: "/schedule",
}

function readPage(): Page {
  switch (window.location.pathname) {
    case "/dashboard":
      return "dashboard"
    case "/setting":
      return "settings"
    case "/schedule":
      return "schedule"
    default:
      return "home"
  }
}

const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((listener) => listener())
}

window.addEventListener("popstate", notify)

function setPage(next: Page) {
  const url = new URL(window.location.href)
  url.pathname = PAGE_PATHS[next]
  url.search = ""
  if (url.href === window.location.href) return
  window.history.pushState({}, "", url)
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** MainNavbar's page switch (Home/Dashboard/Settings), reflected in the
 * URL's own path -- "/" (Home), "/dashboard", "/setting" -- made reactive
 * via useSyncExternalStore + a popstate listener, so clicking a MainNavbar
 * link updates the rendered page immediately instead of needing a reload.
 * Any path this doesn't recognize falls back to Home, since "/" itself is
 * Home rather than a distinct catch-all/not-found case. Serving
 * index.html for all of these paths (not just "/") is the dev server's
 * job (Vite's default SPA fallback already does this) and, in
 * production, whatever static host this ships to. */
export function useCurrentPage(): [Page, (next: Page) => void] {
  const page = useSyncExternalStore(subscribe, readPage)
  const set = useCallback((next: Page) => setPage(next), [])
  return [page, set]
}
