import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { fetchOshiVideos } from "../data/oshiVideos"
import { OSHI_VIDEOS_RANKING_REVEAL_BATCH, oshiVideosQueryKey, type OshiVideosQuery } from "../model/oshiVideosQuery"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import type { VideoPage } from "./useRecentVideos"

interface ShelfResult {
  /** The query this result belongs to -- a result is only ever shown for ITS OWN key. */
  key: string
  videos: RecentVideo[]
  /** Ranking rows fetched but not revealed yet -- revealed locally by loadMore(), never refetched. Always empty for newest/oldest. */
  pending: RecentVideo[]
  nextOffset: number
  hasMore: boolean
  error: Error | null
}

/** `incoming` rows whose videoId is not already shown (nor repeated within the page itself): an offset
 * page can overlap the previous one if the backend's result changes between two requests, and a
 * video must never render twice (it is also the React key). The server's own offset still advances by
 * the rows it returned, so paging never skips or repeats because of this. */
function appendUnique(shown: RecentVideo[], incoming: RecentVideo[]): RecentVideo[] {
  const seen = new Set(shown.map((video) => video.videoId))
  const fresh = incoming.filter((video) => !seen.has(video.videoId) && seen.add(video.videoId))
  return [...shown, ...fresh]
}

/** Home's Oshi Videos shelf data for the current creator + topic + content
 * type + sort + view window. `query === null` (a quick-filter tag, or a
 * creator with no canonical id) means "not this hook's shelf": nothing is
 * fetched and nothing is shown.
 *
 * Correctness rules, all enforced here rather than left to the caller:
 * - Results are keyed by the query: what is returned is empty until a result
 *   for the CURRENT key exists, so a previous creator's/filter's videos can
 *   never render for even one frame after a switch.
 * - A response that resolves after the key changed (rapid filter/creator
 *   switching) is dropped by a generation check, so a stale request can never
 *   overwrite the current shelf; loadMore() is guarded the same way.
 * - The most-viewed ranking is one bounded response: the first batch is shown and loadMore()
 *   reveals the rest locally (no request), so the shelf never renders ~100 cards at once.
 * - A failed request or a valid-but-empty combination shows an empty shelf --
 *   never mock data, another creator's videos, or the previous results.
 * - Paging never drops a request and never gives up: a loadMore() that arrives while a page is in
 *   flight is remembered and runs as soon as that page lands (so a fast scroll can never skip a page);
 *   a FAILED page keeps what is shown, keeps hasMore true, and is retried by the next loadMore() once
 *   LOAD_MORE_RETRY_COOLDOWN_MS has passed. */
/** After a failed page, further loadMore() calls are ignored for this long, so a scroll handler that keeps calling it on a dead
 * connection cannot hammer the API; the first call after it retries the SAME offset. */
export const LOAD_MORE_RETRY_COOLDOWN_MS = 1500

export function useOshiVideos(query: OshiVideosQuery | null): VideoPage {
  const key = query ? oshiVideosQueryKey(query) : null
  // The effect/loadMore below depend on the key alone (the query is fully
  // described by it), so re-creating an equal query object never refetches.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableQuery = useMemo(() => query, [key])

  const [result, setResult] = useState<ShelfResult | null>(null)
  /** Bumped by refresh(): the same query, fetched again from its first page. */
  const [refreshToken, setRefreshToken] = useState(0)
  const refresh = useCallback(() => setRefreshToken((token) => token + 1), [])
  const generationRef = useRef(0)
  const loadingMoreRef = useRef(false)
  /** A loadMore() that arrived while a page was in flight: run as soon as that page lands. */
  const queuedMoreRef = useRef(false)
  const retryNotBeforeRef = useRef(0)

  useEffect(() => {
    const generation = ++generationRef.current
    loadingMoreRef.current = false
    queuedMoreRef.current = false
    retryNotBeforeRef.current = 0
    if (!stableQuery || key === null) return

    fetchOshiVideos(stableQuery, 0)
      .then((page) => {
        if (generation !== generationRef.current) return
        const unique = appendUnique([], page.videos)
        const revealed = stableQuery.sort === "mostViews" ? unique.slice(0, OSHI_VIDEOS_RANKING_REVEAL_BATCH) : unique
        const pending = unique.slice(revealed.length)
        setResult({ key, videos: revealed, pending, nextOffset: page.nextOffset, hasMore: page.hasMore || pending.length > 0, error: null })
      })
      .catch((err: unknown) => {
        if (generation !== generationRef.current) return
        setResult({ key, videos: [], pending: [], nextOffset: 0, hasMore: false, error: err instanceof Error ? err : new Error(String(err)) })
      })
  }, [stableQuery, key, refreshToken])

  const loadMore = useCallback(() => {
    if (!stableQuery || key === null) return
    if (loadingMoreRef.current) {
      queuedMoreRef.current = true // not dropped: it runs when the in-flight page lands
      return
    }
    if (Date.now() < retryNotBeforeRef.current) return
    const current = result
    if (!current || current.key !== key || !current.hasMore) return
    if (current.pending.length > 0) {
      // Ranking: reveal the next batch of the already-fetched rows. Local only -- no request, so no race.
      const next = current.pending.slice(0, OSHI_VIDEOS_RANKING_REVEAL_BATCH)
      const rest = current.pending.slice(next.length)
      setResult((prev) =>
        prev && prev.key === key ? { ...prev, videos: appendUnique(prev.videos, next), pending: rest, hasMore: rest.length > 0 } : prev,
      )
      return
    }
    const generation = generationRef.current
    loadingMoreRef.current = true

    /** Fetches `offset`, appends it, then keeps going while another loadMore() was queued and the source has more. */
    const fetchPage = (offset: number) => {
      fetchOshiVideos(stableQuery, offset)
        .then((page) => {
          if (generation !== generationRef.current) return
          setResult((prev) =>
            prev && prev.key === key
              ? { ...prev, videos: appendUnique(prev.videos, page.videos), nextOffset: page.nextOffset, hasMore: page.hasMore }
              : prev,
          )
          if (queuedMoreRef.current && page.hasMore && page.videos.length > 0) {
            queuedMoreRef.current = false
            fetchPage(page.nextOffset)
            return
          }
          queuedMoreRef.current = false
          loadingMoreRef.current = false
        })
        .catch(() => {
          if (generation !== generationRef.current) return
          // A failed page is NOT the end of the list: what is shown stays, hasMore stays true, and the same offset is retried by a later
          // loadMore() after the cooldown.
          queuedMoreRef.current = false
          retryNotBeforeRef.current = Date.now() + LOAD_MORE_RETRY_COOLDOWN_MS
          loadingMoreRef.current = false
        })
    }
    fetchPage(current.nextOffset)
  }, [stableQuery, key, result])

  if (key === null) return { videos: [], loading: false, error: null, loadMore, hasMore: false, refresh }

  const current = result && result.key === key ? result : null
  return {
    videos: current ? current.videos : [],
    loading: current === null,
    error: current ? current.error : null,
    loadMore,
    hasMore: current ? current.hasMore : false,
    refresh,
  }
}
