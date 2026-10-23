import { useEffect, useMemo, useRef } from "react"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import { resolveCreatorKey } from "../../../entities/creator/data/creatorRegistry"
import { useLiveStreams } from "../../../shared/api/hooks/useLiveStreams"
import type { RecentlyEndedStreamDto } from "../../../shared/api/liveStreams"
import { useNewContent } from "../../../shared/newContent/newContentTracking"
import { HOME_ALL_DEFAULT_CONTROLS, buildShelfQuery } from "../model/oshiVideosQuery"
import { composeHomeAllFeed } from "../utils/latestLiveShelf"
import { useOshiVideos } from "./useOshiVideos"
import { toRecentVideo, type VideoPage } from "./useRecentVideos"

/** Archive states the lifecycle is still actively resolving, or will still hand to the daily job to resolve -- the video must stay visible
 * through both. "unavailable" (YouTube confirms the video is deleted/private/never existed) is excluded on purpose: nothing will ever make it
 * watchable, so it is simply not shown, exactly as it was before this transitional state existed -- never a dead placeholder forever. */
const UNRESOLVED_ARCHIVE_STATUSES = new Set(["pending", "handed_off_to_daily_task"])

/** A confirmed-ended stream/Premiere (GET /live-streams `recentlyEnded`) whose archive tracking.livestream_lifecycle has not verified
 * available yet, as a transitional RecentVideo -- closes the gap between disappearing from the live list and appearing in the archive
 * overlay (api.read_api._with_verified_completed_streams), both derived from the exact same lifecycle record at zero extra request. Same
 * videoId throughout, and the same effective time it already sorted by while LIVE/PREMIERE (actualStart, else scheduledStart), so it does
 * not jump position in Home ALL the moment the real archive row replaces it. contentFormat "archive_pending" keeps it out of
 * isNewContent/isNotYetWatchable exactly like a livestream is kept out while still live -- never a stale LIVE badge, never a confirmed
 * watchable archive before the overlay says so. */
function toPendingRecentVideo(entry: RecentlyEndedStreamDto): RecentVideo {
  const eventAt = entry.actualStart ?? entry.scheduledStart ?? undefined
  return {
    videoId: entry.videoId,
    title: entry.title || entry.videoId,
    publishedAt: eventAt ?? new Date(0).toISOString(),
    ...(eventAt ? { eventAt } : {}),
    contentFormat: "archive_pending",
  }
}

/** The ONE ordered dataset behind Home's Video List ALL and Latest Activity: `videos` is exactly what ALL lists (the creator's current
 * live/upcoming streams first, then the paged archive), and `page` is the archive's own pager. */
export interface HomeAllFeed extends VideoPage {
  /** The paged archive alone (no current streams) -- what the Video List's own shelf state is when ALL is showing. */
  page: VideoPage
  /** Whether the live status is KNOWN, so a discovered video can be told apart from an upcoming Premiere or an ended stream with a pending archive. False while the
   * shared /live-streams read is still loading, and after a failed read that has no earlier answer to fall back on (neither a previous response nor the cached
   * one): in both cases the NEW badges and the unwatched counts stay unavailable ("—") instead of counting a Premiere that is not watchable yet. A failed read
   * with an earlier answer keeps that last-known status, so it never leaves the counts waiting. Undefined (every feed built elsewhere) means known. */
  liveStatusSettled?: boolean
}

/** Home's shared ALL feed for the CURRENT creator: ONE first-page request (the same `/videos/recent` request ALL always made, now also
 * carrying `newSince` so the unwatched count covers the whole list) feeding both Video List ALL and Latest Activity, so Latest Activity
 * never adds a Home request of its own -- later pages are fetched only through loadMore() after scrolling. */
export function useHomeAllFeed(creatorId: string): HomeAllFeed {
  const canonicalCreatorId = resolveCreatorKey(creatorId)?.creatorId
  const { baseline } = useNewContent()
  const query = useMemo(() => buildShelfQuery("all", canonicalCreatorId, HOME_ALL_DEFAULT_CONTROLS), [canonicalCreatorId])
  const page = useOshiVideos(query, { newSince: baseline })
  const { streams, recentlyEnded, isLoading: liveStatusLoading, error: liveStatusError } = useLiveStreams()
  // Known once the read answered; after a failed read only if the store still holds an earlier answer (it keeps the last response, or the cached one on a reload).
  const liveStatusKnown = !liveStatusLoading && (liveStatusError === null || streams.length > 0 || recentlyEnded !== undefined)

  const currentIdsForCreator = useMemo(
    () => (canonicalCreatorId ? streams.filter((stream) => stream.creatorId === canonicalCreatorId).map((stream) => stream.videoId) : []),
    [streams, canonicalCreatorId],
  )
  const pendingForCreator = useMemo(
    () =>
      canonicalCreatorId
        ? (recentlyEnded ?? []).filter(
            (entry) => entry.creatorId === canonicalCreatorId && UNRESOLVED_ARCHIVE_STATUSES.has(entry.archive?.status ?? ""),
          )
        : [],
    [recentlyEnded, canonicalCreatorId],
  )

  // The already-running /live-streams poll (shared, no new polling) is the only signal this needs: once a videoId this hook was
  // watching -- either still live/upcoming/premiere, OR already ended but not yet archive-verified -- stops being either (it
  // resolved to a real archive, YouTube confirmed it unavailable, or it was simply cancelled), refetch the catalog once so the
  // real row -- or its removal -- replaces the placeholder promptly. This also covers the archive becoming available in the SAME
  // completion cycle that confirms the end (no intermediate "pending" ever observed here): the video leaving `current` with no
  // matching pending entry picking it up is itself the signal, not only a pending entry resolving. Never fires merely because the
  // creator switched (useOshiVideos' own key change already refetches that case).
  const watchedRef = useRef<{ creatorId: string | undefined; ids: Set<string> }>({ creatorId: undefined, ids: new Set() })
  useEffect(() => {
    const previous = watchedRef.current
    const current = new Set([...currentIdsForCreator, ...pendingForCreator.map((entry) => entry.videoId)])
    const graduated = previous.creatorId === canonicalCreatorId && [...previous.ids].some((videoId) => !current.has(videoId))
    watchedRef.current = { creatorId: canonicalCreatorId, ids: current }
    if (graduated) page.refresh?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- page.refresh is a stable callback (useOshiVideos); including `page` itself would refire this every render
  }, [currentIdsForCreator, pendingForCreator, canonicalCreatorId])

  const videos = useMemo<RecentVideo[]>(() => {
    // ALL is ONE global chronological order by effective time (composeHomeAllFeed), newest first -- never grouped by
    // LIVE/UPCOMING/PREMIERE/ARCHIVED first. A live stream's own actualStart, an upcoming stream/Premiere's own scheduledStart (never
    // its announcement/discovery time), and an archive's publishedAt all feed the SAME sort.
    const current = canonicalCreatorId ? streams.filter((stream) => stream.creatorId === canonicalCreatorId).map(toRecentVideo) : []
    // composeHomeAllFeed keeps ONE row per videoId, first occurrence wins, so the sources are listed strongest first: every page row except an announced Premiere's (the real
    // rows, exactly as before -- an ordinary provisional row keeps its established place), then the verified archive-pending placeholder, then an announced Premiere's own
    // provisional row. The announced row is last because it carries no lifecycle state beyond "not watchable yet": it must never hide the placeholder's own effective time
    // (the Premiere's real start) or its not-yet-watchable state, and it is only the visible row for the Premiere while no stream or placeholder row exists.
    const pageRows = page.videos.filter((video) => !video.announcedPremiere)
    const announcedRows = page.videos.filter((video) => video.announcedPremiere)
    const archives = [...pageRows, ...pendingForCreator.map(toPendingRecentVideo), ...announcedRows]
    return composeHomeAllFeed(current, archives)
  }, [canonicalCreatorId, streams, page.videos, pendingForCreator])

  return { ...page, videos, page, liveStatusSettled: liveStatusKnown }
}
