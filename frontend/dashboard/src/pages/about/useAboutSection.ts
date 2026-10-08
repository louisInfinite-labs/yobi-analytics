import { useCallback, useSyncExternalStore } from "react"

const SEARCH_PARAM = "section"

function readSection(): string | null {
  return new URLSearchParams(window.location.search).get(SEARCH_PARAM)
}

const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((listener) => listener())
}

window.addEventListener("popstate", notify)

function setSection(next: string) {
  const url = new URL(window.location.href)
  url.searchParams.set(SEARCH_PARAM, next)
  if (url.href === window.location.href) return
  window.history.pushState({}, "", url)
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** About's own active destination, read from and written to this page's own
 * URL as a `?section=` search param on `/about` -- the exact same
 * useSyncExternalStore + popstate + pushState pattern useSettingsSection.ts
 * already uses for Settings. Page identity/order is backend-driven (see
 * aboutContentApi.ts's AboutPage.id), so this hook knows nothing about
 * which ids exist -- the caller passes the CURRENTLY loaded `validIds`
 * (this content payload's own page order) and `defaultId` (its first page)
 * each render, and an unrecognized/missing URL value falls back to that
 * default rather than a hardcoded frontend constant. */
export function useAboutSection(validIds: readonly string[], defaultId: string): [string, (next: string) => void] {
  const raw = useSyncExternalStore(subscribe, readSection)
  const section = raw !== null && validIds.includes(raw) ? raw : defaultId
  const set = useCallback((next: string) => setSection(next), [])
  return [section, set]
}
