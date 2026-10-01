import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { getRecentVideosForCreator } from "../data/mockRecentVideos"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import { resolveCreatorKey } from "../../../entities/creator/data/creatorRegistry"
import { fetchUploadedVideosFromHolodex, type HolodexPage } from "../../../integrations/holodex/holodexClient"
import { useLiveStreams } from "../../../shared/api/hooks/useLiveStreams"
import type { LiveStreamDto } from "../../../shared/api/liveStreams"
import { fetchArchivedLivestreams } from "../data/recentArchivedLivestreams"

/** C6's real-fetch scope is intentionally still just gawr_gura -- the
 * original hand-picked local-testing case (this session's own request to
 * try the real Holodex API for a quick effect check). Broadening this to
 * every registry-resolvable creator belongs to the later Holodex
 * backend/frontend integration work, not this identity-source migration.
 * Gated on the canonical creatorId itself (never a duplicated YouTube
 * channel ID, and never a second hand-picked id->channel table) so the
 * actual channel id still comes entirely from the shared registry below. */
const REAL_FETCH_ENABLED_CREATOR_IDS = new Set<string>(["gawr_gura"])

/** Resolves a legacy ("ch_"-prefixed), aliased, or canonical creatorId to its
 * real YouTube/Holodex channel id via the shared canonical Creator Registry
 * (C5A) -- undefined for a creatorId with no canonical counterpart (e.g.
 * "ch_hololive_staff", a mock/legacy-only entry) or one not in this
 * session's still-narrow real-fetch scope (REAL_FETCH_ENABLED_CREATOR_IDS
 * above), either of which usePaginatedVideos below already treats as "stay
 * on mock data" (see its own `!holodexChannelId` branch). No manually
 * maintained Holodex channel-id table exists anymore
 * (integrations/holodex/holodexChannelIds.ts, retired in C6). */
export function resolveHolodexChannelId(creatorId: string): string | undefined {
  const canonical = resolveCreatorKey(creatorId)
  if (!canonical || !REAL_FETCH_ENABLED_CREATOR_IDS.has(canonical.creatorId)) return undefined
  return canonical.youtubeChannelId
}

export interface VideoPage {
  videos: RecentVideo[]
  loading: boolean
  error: Error | null
  /** Fetches the next page and appends it — a no-op for mock-backed
   * creators (no pagination there) or once `hasMore` is false. Safe to
   * call repeatedly; ignored while a page is already in flight. */
  loadMore: () => void
  /** False once the channel's raw history is exhausted — see each
   * HolodexPage-returning fetcher's own `hasMore` docs for exactly what
   * that means for it. Always false for mock-backed creators. */
  hasMore: boolean
}

type PageFetcher = (holodexChannelId: string, args: { offset: number }) => Promise<HolodexPage>

/** "Latest Videos" ' own independently-paginated pool (fetchUploadedVideosFromHolodex).
 * "Latest Live"'s own archive pool is useArchivedLivestreamPool below (a
 * separate, AWS-backed hook, not this one) -- kept as two separate pools so
 * scrolling one row's prefetch never fires the other row's request (this
 * session's own requirement: scrolling the Latest Live row must only ever
 * trigger more Latest Live requests, never get misclassified as a Latest
 * Videos request). */
function usePaginatedVideos(creatorId: string, holodexChannelId: string | undefined, fetcher: PageFetcher): VideoPage {
  const mockVideos = getRecentVideosForCreator(creatorId)

  const [videos, setVideos] = useState<RecentVideo[]>(mockVideos)
  const [loading, setLoading] = useState(Boolean(holodexChannelId))
  const [error, setError] = useState<Error | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const offsetRef = useRef(0)
  const loadingMoreRef = useRef(false)
  // Mirrors `hasMore` for loadMore()'s guard without a stale closure. False from the moment a new
  // initial request starts until it resolves, so it also blocks loadMore() during initial loading.
  const hasMoreRef = useRef(false)
  // Bumped every time the initial-load effect below re-runs (i.e. creatorId
  // or holodexChannelId changed). loadMore() captures the generation active
  // when it was called and checks it again before touching state, so a
  // loadMore() request still in flight from the PREVIOUS creator can't
  // append its results (or advance offsetRef/hasMore) onto the new
  // creator's pool once it finally resolves (CodeRabbit: "A pending
  // loadMore() request is not scoped to creatorId").
  const generationRef = useRef(0)

  useEffect(() => {
    const generation = ++generationRef.current
    offsetRef.current = 0
    loadingMoreRef.current = false
    hasMoreRef.current = false
    // Reset to the NEW creator's own starting page right away (what a fresh mount shows), so the
    // previous creator's rows never show while this creator's initial request is pending.
    setVideos(mockVideos)
    setHasMore(false)

    if (!holodexChannelId) {
      setLoading(false)
      setError(null)
      return
    }

    setLoading(true)
    setError(null)

    fetcher(holodexChannelId, { offset: 0 })
      .then((result) => {
        if (generation !== generationRef.current) return
        setVideos(result.videos)
        setHasMore(result.hasMore)
        hasMoreRef.current = result.hasMore
        offsetRef.current = result.nextOffset
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (generation !== generationRef.current) return
        setError(err instanceof Error ? err : new Error(String(err)))
        setVideos(mockVideos)
        setHasMore(false)
        hasMoreRef.current = false
        setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mockVideos is
    // stable per creatorId (same object each render for a given id, since
    // mockRecentVideos.ts's map is a static module-level constant); keying
    // off creatorId/holodexChannelId/fetcher alone avoids re-fetching every
    // render. `fetcher` is one of the two module-level exports, also stable.
  }, [creatorId, holodexChannelId, fetcher])

  const loadMore = useCallback(() => {
    // No-op during the initial request and once the channel's history is exhausted (hasMoreRef is false in both).
    if (!holodexChannelId || loadingMoreRef.current || !hasMoreRef.current) return
    const generation = generationRef.current
    loadingMoreRef.current = true

    fetcher(holodexChannelId, { offset: offsetRef.current })
      .then((result) => {
        if (generation !== generationRef.current) return
        setVideos((prev) => [...prev, ...result.videos])
        setHasMore(result.hasMore)
        hasMoreRef.current = result.hasMore
        offsetRef.current = result.nextOffset
      })
      .catch(() => {
        // A failed prefetch just means no more videos load on this scroll
        // — the ones already shown stay put rather than surfacing an error
        // for a background fetch the user didn't directly trigger.
        if (generation === generationRef.current) {
          setHasMore(false)
          hasMoreRef.current = false
        }
      })
      .finally(() => {
        if (generation === generationRef.current) loadingMoreRef.current = false
      })
  }, [holodexChannelId, fetcher])

  return { videos, loading, error, loadMore, hasMore }
}

interface UseRecentVideosResult {
  /** "Latest Videos" — plain (non-stream) uploads only. */
  latestVideos: VideoPage
  /** "Latest Live" — the creator's current live/upcoming stream (if any, from
   * the shared /live-streams store) plus their completed historical
   * archives (AWS). See useLiveStreamVideoPool's own docstring. */
  streamVideos: VideoPage
}

/** One /live-streams item as a RecentVideo -- publishedAt prefers
 * actualStart (when it actually went live) over scheduledStart, the same
 * fallback order holodexClient.ts's own mapVideo already uses for its real
 * Holodex-fetched entries. contentFormat maps status the same way mapVideo
 * does ("live"->"live_now", "upcoming"->"live_upcoming") so
 * recentVideosSelection.ts's existing selectLivestreamSlots (which only
 * ever looks for "live_now"/"live_archive") needs no changes at all -- an
 * "upcoming" entry is simply not selected by it, exactly as before this
 * migration (a real Holodex "upcoming" item was never surfaced there either). */
function toRecentVideo(dto: LiveStreamDto): RecentVideo {
  return {
    videoId: dto.videoId,
    title: dto.title,
    publishedAt: dto.actualStart ?? dto.scheduledStart ?? new Date(0).toISOString(),
    contentFormat: dto.status === "live" ? "live_now" : "live_upcoming",
  }
}

/** The AWS-backed half of "Latest Live": one creator's own COMPLETED
 * historical livestream archives (contentType=live&liveStatus=completed),
 * newest first, from GET /creators/{creatorId}/videos/recent. Defaults to an
 * empty page on any failure (no creator id, request error, or the ranking
 * pipeline not having run yet for this creator/date) rather than falling
 * back to mock data -- unlike usePaginatedVideos' "Latest Videos" pool, a
 * failed archive fetch must never fabricate a video or hide the creator's
 * real current/upcoming stream (that stream comes from a completely
 * separate pool, useLiveStreams, and is merged in below regardless of this
 * pool's own state). */
function useArchivedLivestreamPool(canonicalCreatorId: string | undefined): VideoPage {
  const [videos, setVideos] = useState<RecentVideo[]>([])
  const [loading, setLoading] = useState(Boolean(canonicalCreatorId))
  const [error, setError] = useState<Error | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const offsetRef = useRef(0)
  const loadingMoreRef = useRef(false)
  // Mirrors `hasMore` for loadMore()'s guard without a stale closure. False from the moment a new
  // initial request starts until it resolves, so it also blocks loadMore() during initial loading.
  const hasMoreRef = useRef(false)
  // Same "drop a stale in-flight request from the previous creator" guard as
  // usePaginatedVideos' own generationRef -- see that hook's own comment.
  const generationRef = useRef(0)

  useEffect(() => {
    const generation = ++generationRef.current
    offsetRef.current = 0
    loadingMoreRef.current = false
    hasMoreRef.current = false
    // Clear the previous creator's page right away, so it never shows under the new creator.
    setVideos([])
    setHasMore(false)

    if (!canonicalCreatorId) {
      setLoading(false)
      setError(null)
      return
    }

    setLoading(true)
    setError(null)

    fetchArchivedLivestreams(canonicalCreatorId, { offset: 0 })
      .then((page) => {
        if (generation !== generationRef.current) return
        setVideos(page.videos)
        setHasMore(page.hasMore)
        hasMoreRef.current = page.hasMore
        offsetRef.current = page.nextOffset
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (generation !== generationRef.current) return
        setError(err instanceof Error ? err : new Error(String(err)))
        setVideos([])
        setHasMore(false)
        hasMoreRef.current = false
        setLoading(false)
      })
  }, [canonicalCreatorId])

  const loadMore = useCallback(() => {
    // No-op during the initial request and once the archive is exhausted (hasMoreRef is false in both).
    if (!canonicalCreatorId || loadingMoreRef.current || !hasMoreRef.current) return
    const generation = generationRef.current
    loadingMoreRef.current = true

    fetchArchivedLivestreams(canonicalCreatorId, { offset: offsetRef.current })
      .then((page) => {
        if (generation !== generationRef.current) return
        setVideos((prev) => [...prev, ...page.videos])
        setHasMore(page.hasMore)
        hasMoreRef.current = page.hasMore
        offsetRef.current = page.nextOffset
      })
      .catch(() => {
        if (generation === generationRef.current) {
          setHasMore(false)
          hasMoreRef.current = false
        }
      })
      .finally(() => {
        if (generation === generationRef.current) loadingMoreRef.current = false
      })
  }, [canonicalCreatorId])

  return { videos, loading, error, loadMore, hasMore }
}

/** "Latest Live" = the creator's current live/upcoming stream (Holodex,
 * priority) plus their completed historical archives (AWS), deduplicated by
 * videoId with Holodex winning any collision -- see each source pool's own
 * docstring below. selectLivestreamSlots (recentVideosSelection.ts) decides
 * what actually renders from the merged pool this returns: at most one
 * live_now/live_upcoming item first, then archives newest-first. */
export function useLiveStreamVideoPool(creatorId: string): VideoPage {
  const canonicalCreatorId = resolveCreatorKey(creatorId)?.creatorId
  const { streams, isLoading, error } = useLiveStreams()
  const archivePool = useArchivedLivestreamPool(canonicalCreatorId)

  const videos = useMemo(() => {
    if (!canonicalCreatorId) return []
    const current = streams.filter((stream) => stream.creatorId === canonicalCreatorId).map(toRecentVideo)
    const currentIds = new Set(current.map((video) => video.videoId))
    // Defensive dedup: a stream that just ended could in principle appear in
    // both pools on the same day (still in Holodex's own /live response
    // briefly, and already re-observed as contentType=live/liveStatus=
    // completed by the next collection run) -- Holodex's own current/
    // upcoming entry always wins on a collision, never the archive copy.
    const archives = archivePool.videos.filter((video) => !currentIds.has(video.videoId))
    return [...current, ...archives]
  }, [streams, canonicalCreatorId, archivePool.videos])

  return {
    videos,
    loading: isLoading || archivePool.loading,
    error: error ? new Error(error) : archivePool.error,
    loadMore: archivePool.loadMore,
    hasMore: archivePool.hasMore,
  }
}

/** Mock data by default; real, independently-paginated Holodex data for the
 * small hand-picked subset of creators in REAL_FETCH_ENABLED_CREATOR_IDS
 * above (resolveHolodexChannelId — local testing only, see holodexClient.ts's
 * own docstring on why the API key here must not ship as-is). Falls back to
 * mock on fetch failure so each row still renders something rather than
 * going empty.
 *
 * Each pool starts with one page (this session's own "20+20" target — up
 * to HOLODEX_MAX_LIMIT=50 per row's own dedicated, correctly-typed
 * endpoint) and the caller triggers that pool's own loadMore() once the
 * user has scrolled that row to roughly its 14th-16th card (this session's
 * own requirement: prefetch the next ~20 videos once the user scrolls to
 * around the 14th-16th video). */
export function useRecentVideos(creatorId: string): UseRecentVideosResult {
  const holodexChannelId = resolveHolodexChannelId(creatorId)
  const latestVideos = usePaginatedVideos(creatorId, holodexChannelId, fetchUploadedVideosFromHolodex)
  const streamVideos = useLiveStreamVideoPool(creatorId)
  return { latestVideos, streamVideos }
}
