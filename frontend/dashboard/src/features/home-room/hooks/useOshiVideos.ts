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
 *   never mock data, another creator's videos, or the previous results. */
export function useOshiVideos(query: OshiVideosQuery | null): VideoPage {
  const key = query ? oshiVideosQueryKey(query) : null
  // The effect/loadMore below depend on the key alone (the query is fully
  // described by it), so re-creating an equal query object never refetches.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableQuery = useMemo(() => query, [key])

  const [result, setResult] = useState<ShelfResult | null>(null)
  const generationRef = useRef(0)
  const loadingMoreRef = useRef(false)

  useEffect(() => {
    const generation = ++generationRef.current
    loadingMoreRef.current = false
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
  }, [stableQuery, key])

  const loadMore = useCallback(() => {
    if (!stableQuery || key === null || loadingMoreRef.current) return
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

    fetchOshiVideos(stableQuery, current.nextOffset)
      .then((page) => {
        if (generation !== generationRef.current) return
        setResult((prev) =>
          prev && prev.key === key
            ? { ...prev, videos: appendUnique(prev.videos, page.videos), nextOffset: page.nextOffset, hasMore: page.hasMore }
            : prev,
        )
      })
      .catch(() => {
        // A failed background page just stops further loading; what is shown stays.
        if (generation === generationRef.current) setResult((prev) => (prev && prev.key === key ? { ...prev, hasMore: false } : prev))
      })
      .finally(() => {
        if (generation === generationRef.current) loadingMoreRef.current = false
      })
  }, [stableQuery, key, result])

  if (key === null) return { videos: [], loading: false, error: null, loadMore, hasMore: false }

  const current = result && result.key === key ? result : null
  return {
    videos: current ? current.videos : [],
    loading: current === null,
    error: current ? current.error : null,
    loadMore,
    hasMore: current ? current.hasMore : false,
  }
}
