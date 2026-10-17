import { useMemo } from "react"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import { resolveCreatorKey } from "../../../entities/creator/data/creatorRegistry"
import { useLiveStreams } from "../../../shared/api/hooks/useLiveStreams"
import { useNewContent } from "../../../shared/newContent/newContentTracking"
import { HOME_ALL_DEFAULT_CONTROLS, buildShelfQuery } from "../model/oshiVideosQuery"
import { composeLatestLiveShelf } from "../utils/latestLiveShelf"
import { useOshiVideos } from "./useOshiVideos"
import { toRecentVideo, type VideoPage } from "./useRecentVideos"

/** The ONE ordered dataset behind Home's Video List ALL and Latest Activity: `videos` is exactly what ALL lists (the creator's current
 * live/upcoming streams first, then the paged archive), and `page` is the archive's own pager. */
export interface HomeAllFeed extends VideoPage {
  /** The paged archive alone (no current streams) -- what the Video List's own shelf state is when ALL is showing. */
  page: VideoPage
}

/** Home's shared ALL feed for the CURRENT creator: ONE first-page request (the same `/videos/recent` request ALL always made, now also
 * carrying `newSince` so the unwatched count covers the whole list) feeding both Video List ALL and Latest Activity, so Latest Activity
 * never adds a Home request of its own -- later pages are fetched only through loadMore() after scrolling. */
export function useHomeAllFeed(creatorId: string): HomeAllFeed {
  const canonicalCreatorId = resolveCreatorKey(creatorId)?.creatorId
  const { baseline } = useNewContent()
  const query = useMemo(() => buildShelfQuery("all", canonicalCreatorId, HOME_ALL_DEFAULT_CONTROLS), [canonicalCreatorId])
  const page = useOshiVideos(query, { newSince: baseline })
  const { streams } = useLiveStreams()

  const videos = useMemo<RecentVideo[]>(() => {
    const current = canonicalCreatorId ? streams.filter((stream) => stream.creatorId === canonicalCreatorId).map(toRecentVideo) : []
    return composeLatestLiveShelf(current, page.videos)
  }, [canonicalCreatorId, streams, page.videos])

  return { ...page, videos, page }
}
