import type { RecentVideo } from "../data/mockRecentVideos"
import type { ContentFormat } from "../types/domain"

const BASE_URL = "https://holodex.net/api/v2"

/** Holodex's documented per-request cap (docs.holodex.net: "limit: integer
 * <= 50, Default: 25") — paging must stay at or under this. */
export const HOLODEX_MAX_LIMIT = 50

/** Safety cap on how many raw /videos pages fetchUploadedVideosFromHolodex
 * scans in one call while filtering for normal_video entries (see that
 * function's own docstring) — bounds worst-case request count per
 * loadMore() to 5 * HOLODEX_MAX_LIMIT (250) raw items instead of looping
 * indefinitely against a channel whose recent history is mostly streams. */
const MAX_RAW_PAGES_PER_CALL = 5

interface HolodexVideo {
  id: string
  title: string
  status: "new" | "upcoming" | "live" | "past" | "missing"
  published_at?: string
  available_at?: string
  start_scheduled?: string
  start_actual?: string
}

function mapContentFormat(video: HolodexVideo): ContentFormat {
  if (video.status === "live") return "live_now"
  if (video.status === "upcoming" || video.status === "new") return "live_upcoming"
  if (video.status === "past") return video.start_actual ? "live_archive" : "normal_video"
  return "unknown"
}

function mapVideo(video: HolodexVideo): RecentVideo {
  return {
    videoId: video.id,
    title: video.title,
    publishedAt: video.available_at ?? video.published_at ?? video.start_actual ?? video.start_scheduled ?? new Date().toISOString(),
    contentFormat: mapContentFormat(video),
  }
}

async function holodexFetch(path: string, params: Record<string, string>): Promise<HolodexVideo[]> {
  const apiKey = import.meta.env.VITE_HOLODEX_API_KEY as string | undefined
  if (!apiKey) throw new Error("VITE_HOLODEX_API_KEY is not set — add it to .env.local")

  const query = new URLSearchParams(params).toString()
  const response = await fetch(`${BASE_URL}${path}?${query}`, { headers: { "X-APIKEY": apiKey } })
  if (!response.ok) throw new Error(`Holodex API error ${response.status}`)
  return response.json()
}

interface PageArgs {
  limit?: number
  offset?: number
}

export interface HolodexPage {
  videos: RecentVideo[]
  /** Raw-item offset to pass as this same function's `offset` on the next
   * call to keep paging forward from where this call left off — already
   * accounts for every raw /videos page this call scanned internally, not
   * just one HOLODEX_MAX_LIMIT chunk (see fetchUploadedVideosFromHolodex). */
  nextOffset: number
  /** False once the channel's raw history is exhausted (the last raw page
   * fetched came back shorter than HOLODEX_MAX_LIMIT) — independent of how
   * many matching videos this call actually found, so a call that filtered
   * down to zero results still reports hasMore correctly (CodeRabbit: "The
   * filtered result... makes usePaginatedVideos report hasMore: false
   * whenever it contains fewer than 50 uploads"). */
  hasMore: boolean
}

/** "Latest Live" — archived streams only, straight from Holodex's own
 * `type=stream` filter (this session raised the question of whether the
 * Holodex API even has a filter for stream videos — it does: `type` is
 * "stream" | "clip"). Using the filter instead of
 * pulling everything and hoping enough streams turn up in that page is
 * what actually guarantees this list isn't empty just because a creator
 * happened to publish several plain videos more recently than their last
 * stream (this session's own observed bug: Gura's top 20 by date were all
 * plain uploads, so the old merged-pool approach came back with "no recent
 * streams" even though she has plenty further back).
 *
 * /live (live-now + upcoming) is only meaningful on the first page —
 * merging it in on later pages would re-show the same currently-live
 * video every time. Paginated independently from
 * fetchUploadedVideosFromHolodex (this session's own requirement: scrolling
 * the Latest Live row must only ever trigger more Latest Live requests,
 * never get misclassified as a Latest Videos request). */
export async function fetchArchivedStreamsFromHolodex(
  holodexChannelId: string,
  { limit = HOLODEX_MAX_LIMIT, offset = 0 }: PageArgs = {},
): Promise<HolodexPage> {
  const pageLimit = Math.min(limit, HOLODEX_MAX_LIMIT)
  const streamsRequest = holodexFetch("/videos", {
    channel_id: holodexChannelId,
    type: "stream",
    status: "past",
    sort: "available_at",
    order: "desc",
    limit: String(pageLimit),
    offset: String(offset),
  })
  const liveRequest = offset === 0 ? holodexFetch("/live", { channel_id: holodexChannelId }) : Promise.resolve([])

  const [live, streams] = await Promise.all([liveRequest, streamsRequest])
  return {
    videos: [...live, ...streams].map(mapVideo),
    nextOffset: offset + pageLimit,
    hasMore: streams.length >= pageLimit,
  }
}

/** "Latest Videos" — the channel's own plain (non-stream) uploads. Holodex's
 * `type` enum has no distinct value for these (only "stream" | "clip", and
 * "clip" means fan-made clips of someone else's stream, not the channel's
 * own videos) — so this still pulls `status=past` with no `type` filter and
 * keeps only entries mapContentFormat classifies as normal_video (no
 * start_actual, i.e. never went live). Any stream archives mixed into this
 * same response are simply discarded here — they're covered by
 * fetchArchivedStreamsFromHolodex's own dedicated, correctly-filtered
 * request instead. Paginated independently of that function.
 *
 * Scans successive raw pages (up to MAX_RAW_PAGES_PER_CALL) until `limit`
 * normal_video entries are collected or a raw page comes back shorter than
 * HOLODEX_MAX_LIMIT (channel history exhausted) — a single raw page mixing
 * in enough stream archives could otherwise fall short of `limit` uploads
 * even though later raw pages hold plenty more (CodeRabbit: "If the first
 * raw page contains fewer than 14 normal uploads, RecentVideosSection never
 * reaches PREFETCH_AT_INDEX"). `nextOffset` reflects every raw page
 * consumed here, so the caller's next call resumes after all of them, not
 * just one HOLODEX_MAX_LIMIT chunk. */
export async function fetchUploadedVideosFromHolodex(
  holodexChannelId: string,
  { limit = HOLODEX_MAX_LIMIT, offset = 0 }: PageArgs = {},
): Promise<HolodexPage> {
  const collected: RecentVideo[] = []
  let rawOffset = offset
  let hasMore = true

  for (let page = 0; page < MAX_RAW_PAGES_PER_CALL && collected.length < limit; page++) {
    const rawPage = await holodexFetch("/videos", {
      channel_id: holodexChannelId,
      status: "past",
      sort: "available_at",
      order: "desc",
      limit: String(HOLODEX_MAX_LIMIT),
      offset: String(rawOffset),
    })
    collected.push(...rawPage.map(mapVideo).filter((video) => video.contentFormat === "normal_video"))
    rawOffset += HOLODEX_MAX_LIMIT
    if (rawPage.length < HOLODEX_MAX_LIMIT) {
      hasMore = false
      break
    }
  }

  return { videos: collected.slice(0, limit), nextOffset: rawOffset, hasMore }
}
