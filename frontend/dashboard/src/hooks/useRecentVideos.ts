import { useCallback, useEffect, useRef, useState } from "react"
import { getRecentVideosForCreator, type RecentVideo } from "../data/mockRecentVideos"
import { holodexChannelIdByCreatorId } from "../data/holodexChannelIds"
import {
  fetchArchivedStreamsFromHolodex,
  fetchUploadedVideosFromHolodex,
  HOLODEX_MAX_LIMIT,
} from "../lib/holodexClient"

interface VideoPage {
  videos: RecentVideo[]
  loading: boolean
  error: Error | null
  /** Fetches the next page (offset += HOLODEX_MAX_LIMIT) and appends it —
   * a no-op for mock-backed creators (no pagination there) or once
   * `hasMore` is false. Safe to call repeatedly; ignored while a page is
   * already in flight. */
  loadMore: () => void
  /** False once a page comes back with fewer than HOLODEX_MAX_LIMIT items
   * — the channel's history is exhausted, so further loadMore() calls are
   * no-ops. Always false for mock-backed creators. */
  hasMore: boolean
}

type PageFetcher = (holodexChannelId: string, args: { offset: number }) => Promise<RecentVideo[]>

/** One independently-paginated video pool — either "最新影片" (backed by
 * fetchUploadedVideosFromHolodex) or "最新直播" (fetchArchivedStreamsFromHolodex).
 * Kept as two separate instances of this same hook (see useRecentVideos
 * below) rather than one merged pool, so scrolling one row's prefetch
 * never fires the other row's request (this session: "user 滑動 最新直播時
 * ... 只會再發生api request 取 更多的最新直播 最新影片的判定不會被觸發"). */
function usePaginatedVideos(creatorId: string, holodexChannelId: string | undefined, fetcher: PageFetcher): VideoPage {
  const mockVideos = getRecentVideosForCreator(creatorId)

  const [videos, setVideos] = useState<RecentVideo[]>(mockVideos)
  const [loading, setLoading] = useState(Boolean(holodexChannelId))
  const [error, setError] = useState<Error | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const offsetRef = useRef(0)
  const loadingMoreRef = useRef(false)

  useEffect(() => {
    offsetRef.current = 0
    loadingMoreRef.current = false

    if (!holodexChannelId) {
      setVideos(mockVideos)
      setLoading(false)
      setError(null)
      setHasMore(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    fetcher(holodexChannelId, { offset: 0 })
      .then((result) => {
        if (cancelled) return
        setVideos(result)
        setHasMore(result.length >= HOLODEX_MAX_LIMIT)
        offsetRef.current = HOLODEX_MAX_LIMIT
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err : new Error(String(err)))
        setVideos(mockVideos)
        setHasMore(false)
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mockVideos is
    // stable per creatorId (same object each render for a given id, since
    // mockRecentVideos.ts's map is a static module-level constant); keying
    // off creatorId/holodexChannelId/fetcher alone avoids re-fetching every
    // render. `fetcher` is one of the two module-level exports, also stable.
  }, [creatorId, holodexChannelId, fetcher])

  const loadMore = useCallback(() => {
    if (!holodexChannelId || loadingMoreRef.current) return
    loadingMoreRef.current = true

    fetcher(holodexChannelId, { offset: offsetRef.current })
      .then((nextPage) => {
        setVideos((prev) => [...prev, ...nextPage])
        setHasMore(nextPage.length >= HOLODEX_MAX_LIMIT)
        offsetRef.current += HOLODEX_MAX_LIMIT
      })
      .catch(() => {
        // A failed prefetch just means no more videos load on this scroll
        // — the ones already shown stay put rather than surfacing an error
        // for a background fetch the user didn't directly trigger.
        setHasMore(false)
      })
      .finally(() => {
        loadingMoreRef.current = false
      })
  }, [holodexChannelId, fetcher])

  return { videos, loading, error, loadMore, hasMore }
}

interface UseRecentVideosResult {
  /** "最新影片" — plain (non-stream) uploads only. */
  latestVideos: VideoPage
  /** "最新直播" — live-now/upcoming + archived streams only. */
  streamVideos: VideoPage
}

/** Mock data by default; real, independently-paginated Holodex data for the
 * small hand-picked subset of creators in holodexChannelIds.ts (this
 * session: "我淨係要試真HOLODEX API 效果" — local testing only, see
 * holodexClient.ts's own docstring on why the API key here must not ship
 * as-is). Falls back to mock on fetch failure so each row still renders
 * something rather than going empty.
 *
 * Each pool starts with one page (this session's own "20+20" target — up
 * to HOLODEX_MAX_LIMIT=50 per row's own dedicated, correctly-typed
 * endpoint) and the caller triggers that pool's own loadMore() once the
 * user has scrolled that row to roughly its 14th-16th card (this session:
 * "user往右滑到14-16支影片時 再預入後20支影片"). */
export function useRecentVideos(creatorId: string): UseRecentVideosResult {
  const holodexChannelId = holodexChannelIdByCreatorId[creatorId]
  const latestVideos = usePaginatedVideos(creatorId, holodexChannelId, fetchUploadedVideosFromHolodex)
  const streamVideos = usePaginatedVideos(creatorId, holodexChannelId, fetchArchivedStreamsFromHolodex)
  return { latestVideos, streamVideos }
}
