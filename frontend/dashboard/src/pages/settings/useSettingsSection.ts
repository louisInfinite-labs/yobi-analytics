import { useCallback, useSyncExternalStore } from "react"
import type { SettingsSection } from "./SettingsSecondaryNavbar"

const SEARCH_PARAM = "section"
const VALID_SECTIONS: readonly SettingsSection[] = ["myOshi", "oshi", "notification", "display"]
const DEFAULT_SECTION: SettingsSection = "oshi"

function isSettingsSection(value: string | null): value is SettingsSection {
  return value !== null && (VALID_SECTIONS as readonly string[]).includes(value)
}

function readSection(): SettingsSection {
  const raw = new URLSearchParams(window.location.search).get(SEARCH_PARAM)
  return isSettingsSection(raw) ? raw : DEFAULT_SECTION
}

const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((listener) => listener())
}

window.addEventListener("popstate", notify)

function setSection(next: SettingsSection) {
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

/** Settings' own active sub-page (我推設定 / 收藏名單 / 推送通知 / 顯示設定), read from
 * and written to this page's own URL as a `?section=` search param on
 * `/setting` -- the same useSyncExternalStore + popstate + pushState
 * pattern useCurrentPage.ts already uses for the top-level page switch,
 * rather than a second, parallel routing mechanism. A plain component-local
 * useState (the previous implementation) resets to its hardcoded default on
 * every remount, including a full browser reload, which is exactly the bug
 * this replaces. A missing or unrecognized `section` value falls back to
 * "oshi" (Favorites List), matching the previous hardcoded default, so
 * fresh entry into Settings from MainNavbar (which clears the URL's search
 * string on every top-level page switch -- see useCurrentPage.ts's own
 * setPage) is unaffected by this change. */
export function useSettingsSection(): [SettingsSection, (next: SettingsSection) => void] {
  const section = useSyncExternalStore(subscribe, readSection)
  const set = useCallback((next: SettingsSection) => setSection(next), [])
  return [section, set]
}
