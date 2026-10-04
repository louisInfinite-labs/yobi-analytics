import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import { resolveCreatorKey } from "../../../entities/creator/data/creatorRegistry"
import { useLiveStreams } from "../../../shared/api/hooks/useLiveStreams"
import type { LiveStreamDto } from "../../../shared/api/liveStreams"
import { fetchArchivedLivestreams } from "../data/recentArchivedLivestreams"

export interface VideoPage {
  videos: RecentVideo[]
  loading: boolean
  error: Error | null
  /** Fetches the next page and appends it. Safe to call repeatedly; ignored while a page is already in
   * flight, and a no-op once `hasMore` is false. */
  loadMore: () => void
  /** False once the source's history is exhausted. */
  hasMore: boolean
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

/** The AWS-backed half of the player's stream pool: one creator's own COMPLETED
 * historical livestream archives (contentType=live&liveStatus=completed),
 * newest first, from GET /creators/{creatorId}/videos/recent. Defaults to an
 * empty page on any failure (no creator id, request error, or the ranking
 * pipeline not having run yet for this creator/date) -- a failed archive
 * fetch must never fabricate a video or hide the creator's real
 * current/upcoming stream (that stream comes from a completely separate
 * pool, useLiveStreams, and is merged in below regardless of this pool's
 * own state). */
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
  // Bumped every time the initial-load effect below re-runs (i.e. the creator changed). loadMore()
  // captures the generation active when it was called and checks it again before touching state, so a
  // request still in flight from the PREVIOUS creator can't append its results onto the new creator's pool.
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

/** The stream pool behind Home's central player: the creator's current live/upcoming stream (Holodex,
 * priority) plus their completed historical archives (AWS), deduplicated by
 * videoId with Holodex winning any collision -- see each source pool's own
 * docstring. selectLivestreamSlots (recentVideosSelection.ts) decides
 * what actually renders from the merged pool this returns: at most one
 * live_now/live_upcoming item first, then archives newest-first. Only the player's auto-selected
 * video reads this pool; the Oshi Videos shelf (useOshiVideos) fetches its own backend data. */
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
