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

/** Build the localStorage key for one (timeZone, reportDate, period) cache slot. */
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
    const parsed: unknown = JSON.parse(raw)
    return isValidCacheEntry(parsed, key) ? parsed : null
  } catch {
    return null
  }
}

/** Runtime shape check for a value read out of localStorage — an older app
 * version's entry, a partially-written value, or hand-edited storage could
 * otherwise pass the identity check below despite missing `results`,
 * `comparisonDate`, or `fetchedAt`, and a bare `as CacheEntry` type
 * assertion would let it through as if it were valid. */
function isValidCacheEntry(value: unknown, key: CacheKey): value is CacheEntry {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    entry.timeZone === key.timeZone &&
    entry.reportDate === key.reportDate &&
    entry.period === key.period &&
    typeof entry.comparisonDate === "string" &&
    typeof entry.fetchedAt === "string" &&
    Array.isArray(entry.results) &&
    entry.results.every(isValidDailyVideoStat)
  )
}

/** Runtime shape check for one cached DailyVideoStat element — `Array.isArray`
 * alone accepts `[null]` or `[{}]` as a valid `DailyVideoStat[]`, which would
 * then crash every downstream consumer (filters, KPI/derivation code, the
 * table) the moment it reads a missing field. Checks only the fields those
 * consumers actually read, not every field on the type. */
function isValidDailyVideoStat(value: unknown): value is DailyVideoStat {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.videoId === "string" &&
    typeof v.videoTitle === "string" &&
    typeof v.channelId === "string" &&
    typeof v.channelName === "string" &&
    typeof v.organization === "string" &&
    typeof v.branch === "string" &&
    Array.isArray(v.groupKey) &&
    typeof v.channelType === "string" &&
    typeof v.lifecycleStage === "string" &&
    typeof v.contentFormat === "string" &&
    Array.isArray(v.contentTags) &&
    typeof v.totalViews === "number" &&
    typeof v.dailyIncrease === "number" &&
    (v.growthPercent === null || typeof v.growthPercent === "number") &&
    typeof v.collectedAt === "string" &&
    typeof v.status === "string"
  )
}

/** Write an entry to this exact (timeZone, reportDate, period) cache slot; never throws. */
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
