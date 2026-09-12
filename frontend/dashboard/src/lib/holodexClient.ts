import type { RecentVideo } from "../data/mockRecentVideos"
import type { ContentFormat } from "../types/domain"

const BASE_URL = "https://holodex.net/api/v2"

/** Holodex's documented per-request cap (docs.holodex.net: "limit: integer
 * <= 50, Default: 25") — paging must stay at or under this. */
export const HOLODEX_MAX_LIMIT = 50

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

/** "最新直播" — archived streams only, straight from Holodex's own
 * `type=stream` filter (this session: "holodex api 沒有直播影片這個filter
 * 嗎?" — it does: `type` is "stream" | "clip"). Using the filter instead of
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
 * fetchUploadedVideosFromHolodex (this session: "user 滑動 最新直播時 ...
 * 只會再發生api request 取 更多的最新直播 最新影片的判定不會被觸發"). */
export async function fetchArchivedStreamsFromHolodex(
  holodexChannelId: string,
  { limit = HOLODEX_MAX_LIMIT, offset = 0 }: PageArgs = {},
): Promise<RecentVideo[]> {
  const streamsRequest = holodexFetch("/videos", {
    channel_id: holodexChannelId,
    type: "stream",
    status: "past",
    sort: "available_at",
    order: "desc",
    limit: String(Math.min(limit, HOLODEX_MAX_LIMIT)),
    offset: String(offset),
  })
  const liveRequest = offset === 0 ? holodexFetch("/live", { channel_id: holodexChannelId }) : Promise.resolve([])

  const [live, streams] = await Promise.all([liveRequest, streamsRequest])
  return [...live, ...streams].map(mapVideo)
}

/** "最新影片" — the channel's own plain (non-stream) uploads. Holodex's
 * `type` enum has no distinct value for these (only "stream" | "clip", and
 * "clip" means fan-made clips of someone else's stream, not the channel's
 * own videos) — so this still pulls `status=past` with no `type` filter and
 * keeps only entries mapContentFormat classifies as normal_video (no
 * start_actual, i.e. never went live). Any stream archives mixed into this
 * same response are simply discarded here — they're covered by
 * fetchArchivedStreamsFromHolodex's own dedicated, correctly-filtered
 * request instead. Paginated independently of that function. */
export async function fetchUploadedVideosFromHolodex(
  holodexChannelId: string,
  { limit = HOLODEX_MAX_LIMIT, offset = 0 }: PageArgs = {},
): Promise<RecentVideo[]> {
  const videos = await holodexFetch("/videos", {
    channel_id: holodexChannelId,
    status: "past",
    sort: "available_at",
    order: "desc",
    limit: String(Math.min(limit, HOLODEX_MAX_LIMIT)),
    offset: String(offset),
  })
  return videos.map(mapVideo).filter((video) => video.contentFormat === "normal_video")
}
