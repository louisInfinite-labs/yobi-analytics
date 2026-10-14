import { useCallback, useSyncExternalStore } from "react"
import { resolveCreatorKey, toLegacyRosterId } from "../../entities/creator/data/creatorRegistry"
import { readDefaultOshiCreatorId } from "../../features/oshi/hooks/useDefaultOshiCreator"
import { selectedCreatorStore } from "../../features/oshi/hooks/useSelectedCreator"
import { creatorPath, parseCreatorRoute } from "./creatorRoutes"
import { readSessionHomePath, writeSessionHomePath } from "./sessionHomePath"

export type Page = "home" | "dashboard" | "settings" | "schedule" | "about" | "videos"

/** The fixed (non-creator) pages. Home is either the root "/" or an explicit /creator/:creatorSlug (see creatorRoutes.ts).
 * "videos" (the mobile-only Videos/Search view) stays reachable by direct URL on any viewport -- VideosPage itself
 * redirects back to Home when the current breakpoint isn't mobile, rather than this routing layer knowing about
 * breakpoints at all. */
const PAGE_PATHS: Record<Exclude<Page, "home">, string> = {
  dashboard: "/dashboard",
  settings: "/setting",
  schedule: "/schedule",
  about: "/about",
  videos: "/videos",
}

function readPage(): Page {
  switch (window.location.pathname) {
    case "/dashboard":
      // Development-only (see MainNavbar): in production this URL is not a page, so it falls through to Home like any unknown path.
      return import.meta.env.DEV ? "dashboard" : "home"
    case "/setting":
      return "settings"
    case "/schedule":
      return "schedule"
    case "/about":
      return "about"
    case "/videos":
      return "videos"
    default:
      // "/", "/creator/:slug" and any unknown path: Home.
      return "home"
  }
}

const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((listener) => listener())
}

/** Home's two kinds of route:
 *  - the root "/" is the entry Home: it ALWAYS shows the Oshi (else the default first creator) and keeps the URL "/" -- a visit is never
 *    rewritten into a creator path;
 *  - "/creator/:slug" is an explicit creator Home: that creator is shown, the URL is the source of truth, and a direct link beats the Oshi.
 * Either way the Home route is remembered for this browser session (sessionHomePath.ts), so coming back to Home returns to exactly it. */
function syncRouteWithCreator(): void {
  const url = new URL(window.location.href)
  if (url.searchParams.has("admin")) return
  const route = parseCreatorRoute(url.pathname)
  if (route?.kind === "creator") {
    selectedCreatorStore.set(toLegacyRosterId(route.creator))
    writeSessionHomePath(creatorPath(route.creator))
    return
  }
  if (route?.kind === "invalid") {
    // An unknown/malformed creator slug is never shown under its own URL (and never as a different creator): fall back to the root Home.
    url.pathname = "/"
    window.history.replaceState(window.history.state, "", url)
  }
  if (url.pathname === "/") {
    selectedCreatorStore.set(readDefaultOshiCreatorId())
    writeSessionHomePath("/")
  }
}

syncRouteWithCreator()
window.addEventListener("popstate", () => {
  syncRouteWithCreator()
  notify()
})

function navigate(pathname: string, { keepSearch = false }: { keepSearch?: boolean } = {}) {
  const url = new URL(window.location.href)
  url.pathname = pathname
  if (!keepSearch) url.search = ""
  if (url.href === window.location.href) return
  window.history.pushState({}, "", url)
  notify()
}

/** Goes to a page. Home means the Home route last shown in this session: an explicit creator's /creator/:slug, or the root "/" (the Oshi) if
 * the user has not switched creator. */
export function goToPage(next: Page): void {
  if (next !== "home") return navigate(PAGE_PATHS[next])
  const home = readSessionHomePath()
  if (home === "/") selectedCreatorStore.set(readDefaultOshiCreatorId())
  navigate(home)
}

/** Explicitly picks a creator from ANY page (Live Status): that creator becomes the session's Home route and the app moves to
 * /creator/:slug at once -- on Schedule/Settings/About it leaves the page for that creator's Home, on Home it just switches creator and URL.
 * A key that is not a known creator does nothing. */
export function selectCreator(creatorKey: string): void {
  const creator = resolveCreatorKey(creatorKey)
  if (!creator) return
  const path = creatorPath(creator)
  selectedCreatorStore.set(toLegacyRosterId(creator))
  writeSessionHomePath(path)
  navigate(path)
}

/** The creator switch that goes with picking another creator's STREAM in Live Status. On Home it is selectCreator (the URL follows the creator
 * shown); off Home it only switches the creator and the session's Home route, WITHOUT navigating, so the stream still opens where it always has
 * (the player modal) and Home later shows that creator. Stream picks are not changed by creator routing. */
export function switchCreatorForVideo(creatorKey: string): void {
  if (readPage() === "home") return selectCreator(creatorKey)
  const creator = resolveCreatorKey(creatorKey)
  if (!creator) return
  selectedCreatorStore.set(toLegacyRosterId(creator))
  writeSessionHomePath(creatorPath(creator))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The current URL path, reactive to every in-app navigation and Back/Forward (Analytics counts one page view per path change). */
export function useCurrentPath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname)
}

/** MainNavbar's page switch (Home/Schedule/Settings/About, plus the dev-only Video Data), reflected in the URL's own path and made reactive
 * via useSyncExternalStore + a popstate listener, so clicking a MainNavbar link updates the rendered page immediately instead of needing a
 * reload. Serving index.html for these paths is the dev server's job (Vite's default SPA fallback) and, in production, Firebase Hosting's SPA
 * rewrite. */
export function useCurrentPage(): [Page, (next: Page) => void] {
  const page = useSyncExternalStore(subscribe, readPage)
  const set = useCallback((next: Page) => goToPage(next), [])
  return [page, set]
}
