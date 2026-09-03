import type { DailyVideoStat, Period } from "../types/domain"

const CACHE_PREFIX = "yobi-analytics-cache"

/** Cache identity must include (timeZone, reportDate, period) — Roadmap 3.6 —
 * so e.g. Tokyo's and Hong Kong's different calendar-date results for the
 * "same" moment can never overwrite or masquerade as each other. */
export interface CacheKey {
  timeZone: string
  reportDate: string
  period: Period
}

export interface CacheEntry {
  timeZone: string
  reportDate: string
  comparisonDate: string
  period: Period
  fetchedAt: string
  results: DailyVideoStat[]
}

function cacheKeyString(key: CacheKey): string {
  return `${CACHE_PREFIX}:${key.timeZone}:${key.reportDate}:${key.period}`
}

/** Read a cached entry for this exact (timeZone, reportDate, period), or
 * null if absent/corrupt/storage unavailable. Never throws — a cache is a
 * perf optimization, not a correctness requirement, so any failure here
 * degrades to "no cache" rather than breaking the page. */
export function readCache(key: CacheKey, storage?: Storage): CacheEntry | null {
  try {
    const raw = (storage ?? window.localStorage).getItem(cacheKeyString(key))
    if (!raw) return null
    const parsed = JSON.parse(raw) as CacheEntry
    if (parsed.timeZone !== key.timeZone || parsed.reportDate !== key.reportDate || parsed.period !== key.period) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function writeCache(key: CacheKey, entry: CacheEntry, storage?: Storage): void {
  try {
    ;(storage ?? window.localStorage).setItem(cacheKeyString(key), JSON.stringify(entry))
  } catch {
    // Storage full/unavailable (private browsing, quota) — silently skip caching.
  }
}

/** Whether a freshly fetched entry should replace what's cached — Roadmap
 * 3.6's "compare snapshotDate/version, replace cache if newer". Everything
 * not strictly newer (including equal) keeps the existing cache, so a
 * background fetch that raced and returned the same fetchedAt never causes
 * a pointless re-render/write. */
export function isNewer(incoming: CacheEntry, cached: CacheEntry | null): boolean {
  if (cached === null) return true
  return incoming.fetchedAt > cached.fetchedAt
}
