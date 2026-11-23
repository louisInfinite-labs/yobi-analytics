import { useCallback, useSyncExternalStore } from "react"
import { resolveCreatorKey, toLegacyRosterId } from "../../entities/creator/data/creatorRegistry"
import { readDefaultOshiCreatorId } from "../../features/oshi/hooks/useDefaultOshiCreator"
import { selectedCreatorStore } from "../../features/oshi/hooks/useSelectedCreator"
import { CREATOR_PARAM, VIDEO_PARAM } from "../../features/video-deep-link/videoDeepLinkParam"
import { writeSessionCreatorId } from "./sessionCreator"

export type Page = "home" | "dashboard" | "settings" | "schedule" | "about"

/** Every page's one URL. Home is always the root "/": which creator Home shows is in-app state (selectedCreatorStore), never part of the URL. */
const PAGE_PATHS: Record<Page, string> = {
  home: "/",
  dashboard: "/dashboard",
  settings: "/setting",
  schedule: "/schedule",
  about: "/about",
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
    default:
      // "/" and any unknown path (which the host answers with HTTP 404 and a noindex page): Home.
      return "home"
  }
}

const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((listener) => listener())
}

/** Applies a notification's `?creator=<creatorId>` on the root Home (public/sw.js turns the creator route a push payload carries into it, and
 * firebase.json redirects a retired /creator/<slug> URL -- e.g. opened by a not-yet-updated service worker -- to it): that
 * creator is shown and becomes the session's creator. The parameter is removed from the address bar once used -- unless a `?video=` deep link
 * still needs it to know which creator the video belongs to (useVideoDeepLink then removes both). An unknown or inactive creator is ignored. */
function applyCreatorParam(): void {
  const url = new URL(window.location.href)
  if (url.pathname !== "/" || !url.searchParams.has(CREATOR_PARAM)) return
  const creator = resolveCreatorKey(url.searchParams.get(CREATOR_PARAM) ?? "")
  if (creator?.active) {
    selectedCreatorStore.set(toLegacyRosterId(creator))
    writeSessionCreatorId(toLegacyRosterId(creator))
    if (url.searchParams.has(VIDEO_PARAM)) return
  }
  url.searchParams.delete(CREATOR_PARAM)
  window.history.replaceState(window.history.state, "", url)
}

applyCreatorParam() // a page load opened from a notification
window.addEventListener("popstate", () => {
  applyCreatorParam()
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

/** Whether the creator Home is currently showing still exists in the roster. Favorites / Oshi membership is deliberately NOT consulted: being
 * removed from the favorites list does not make a creator invalid. */
function isValidCreatorSelection(): boolean {
  return resolveCreatorKey(selectedCreatorStore.get()) !== undefined
}

/** Goes to a page. Home keeps the creator it was showing (a creator switched to earlier in the session); only an invalid one falls back to the Oshi. */
export function goToPage(next: Page): void {
  if (next === "home" && !isValidCreatorSelection()) selectedCreatorStore.set(readDefaultOshiCreatorId())
  navigate(PAGE_PATHS[next])
}

/** The URL goToPage(page) lands on, for a navigation link's href. */
export function pageHref(page: Page): string {
  return PAGE_PATHS[page]
}

/** Explicitly picks a creator from ANY page (Live Status): Home shows that creator from now on in this session, and the app moves to Home at
 * once -- on Schedule/Settings/About it leaves the page for Home, on Home it just switches creator (the URL stays "/"). A key that is not a known
 * creator does nothing. */
export function selectCreator(creatorKey: string): void {
  const creator = resolveCreatorKey(creatorKey)
  if (!creator) return
  selectedCreatorStore.set(toLegacyRosterId(creator))
  writeSessionCreatorId(toLegacyRosterId(creator))
  navigate(PAGE_PATHS.home)
}

/** The creator switch that goes with picking another creator's STREAM in Live Status. On Home it is selectCreator; off Home it only switches the
 * creator WITHOUT navigating, so the stream still opens where it always has (the player modal) and Home later shows that creator. */
export function switchCreatorForVideo(creatorKey: string): void {
  if (readPage() === "home") return selectCreator(creatorKey)
  const creator = resolveCreatorKey(creatorKey)
  if (!creator) return
  selectedCreatorStore.set(toLegacyRosterId(creator))
  writeSessionCreatorId(toLegacyRosterId(creator))
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
 * reload. Each page's HTML is a real file in the build (Firebase Hosting serves it); in development Vite's SPA fallback serves index.html. */
export function useCurrentPage(): [Page, (next: Page) => void] {
  const page = useSyncExternalStore(subscribe, readPage)
  const set = useCallback((next: Page) => goToPage(next), [])
  return [page, set]
}
