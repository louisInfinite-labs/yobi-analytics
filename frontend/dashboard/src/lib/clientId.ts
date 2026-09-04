const CLIENT_ID_STORAGE_KEY = "yobi-analytics-client-id"

/** Return this browser's stable anonymous clientId (Roadmap 4.3), creating
 * and persisting one on first call via `localStorage` — the same mechanism
 * `analyticsCache.ts` (3.6) already uses. Independent of any Read API call
 * and never derived from a Google/YouTube account or email. Never throws:
 * storage unavailable (private browsing, quota) falls back to a fresh id
 * for this call only, since a clientId is best-effort identity, not a
 * correctness requirement — callers should not assume it's stable across
 * calls when storage itself is unavailable. */
export function getOrCreateClientId(storage?: Storage): string {
  try {
    const store = storage ?? window.localStorage
    const existing = store.getItem(CLIENT_ID_STORAGE_KEY)
    if (existing) return existing
    const created = crypto.randomUUID()
    store.setItem(CLIENT_ID_STORAGE_KEY, created)
    return created
  } catch {
    return crypto.randomUUID()
  }
}
