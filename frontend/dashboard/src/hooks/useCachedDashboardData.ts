import { useEffect, useState } from "react"
import { isNewer, readCache, writeCache, type CacheEntry, type CacheKey } from "../lib/analyticsCache"

interface UseCachedDashboardDataResult {
  entry: CacheEntry | null
  /** True only while there is nothing at all to show yet (no cache and the
   * first fetch hasn't resolved) — Roadmap 3.6: cached data displays
   * immediately, so a cache hit skips this loading state entirely. */
  loading: boolean
  /** Set when the background fetch rejects. Cached data (if any) remains in
   * `entry` and displayed — a failed refresh doesn't erase what's already
   * shown; the caller decides whether/how to surface this alongside it. */
  error: Error | null
}

/** Roadmap 3.6 flow: read local cache -> display cached data immediately ->
 * background-fetch the latest data -> compare fetchedAt -> replace the
 * cache only if the fetch is actually newer. `fetchFn` stands in for the
 * future Read API call (Roadmap 3.4); it's a plain async function so this
 * hook doesn't know or care whether the data came from mocks or a real
 * network request. */
export function useCachedDashboardData(key: CacheKey, fetchFn: () => Promise<CacheEntry>): UseCachedDashboardDataResult {
  const keySignature = `${key.timeZone}:${key.reportDate}:${key.period}`

  const [entry, setEntry] = useState<CacheEntry | null>(() => readCache(key))
  const [loading, setLoading] = useState(entry === null)
  const [error, setError] = useState<Error | null>(null)

  // When `key` changes (e.g. the user switches period/time zone), swap to
  // the new key's own cached entry synchronously during render rather than
  // in the effect below — an effect only runs after this render has
  // already committed and painted, which would show the *previous* key's
  // stale entry for one frame before correcting itself.
  const [lastKeySignature, setLastKeySignature] = useState(keySignature)
  if (keySignature !== lastKeySignature) {
    setLastKeySignature(keySignature)
    const cached = readCache(key)
    setEntry(cached)
    setLoading(cached === null)
    setError(null)
  }

  useEffect(() => {
    let cancelled = false

    fetchFn()
      .then((fresh) => {
        if (cancelled) return
        setEntry((current) => {
          if (isNewer(fresh, current)) {
            writeCache(key, fresh)
            return fresh
          }
          return current
        })
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err : new Error(String(err)))
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySignature])

  return { entry, loading, error }
}
