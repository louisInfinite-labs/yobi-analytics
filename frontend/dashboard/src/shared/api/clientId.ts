const CLIENT_ID_STORAGE_KEY = "yobi-analytics-client-id"

// Cached in module memory so repeated calls during one page session return
// the same id when storage itself is unavailable (private browsing,
// quota) — a fresh UUID per call would otherwise let NotificationToggle's
// enable and disable calls (each calling this independently) act on two
// different "clients", e.g. leaving the enabled subscription/preference
// from the first call permanently orphaned once storage failure causes the
// disable call to mint and act on a different id.
let _fallbackClientId: string | null = null

/** Return this browser's stable anonymous clientId (Roadmap 4.3), creating
 * and persisting one on first call via `localStorage` — the same mechanism
 * `analyticsCache.ts` (3.6) already uses. Independent of any Read API call
 * and never derived from a Google/YouTube account or email. Never throws:
 * storage unavailable (private browsing, quota) falls back to one id
 * cached for the rest of this page session (see `_fallbackClientId`)
 * rather than a fresh one per call — still not stable across a reload,
 * since nothing persisted it, but at least self-consistent within one. */
export function getOrCreateClientId(storage?: Storage): string {
  try {
    const store = storage ?? window.localStorage
    const existing = store.getItem(CLIENT_ID_STORAGE_KEY)
    if (existing) return existing
    const created = crypto.randomUUID()
    store.setItem(CLIENT_ID_STORAGE_KEY, created)
    return created
  } catch {
    if (_fallbackClientId === null) {
      _fallbackClientId = crypto.randomUUID()
    }
    return _fallbackClientId
  }
}
