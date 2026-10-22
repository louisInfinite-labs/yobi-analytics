import type { RecentVideo } from "../../../shared/media/model/recentVideo"

function timeOf(value: string | undefined): number {
  return value ? new Date(value).getTime() : Number.NaN
}

/** Orders by `timeOf` in `direction`, an unknown/unparseable time last, ties broken by videoId so the order is
 * deterministic. */
function compareByTime(timeOfVideo: (video: RecentVideo) => number, direction: "asc" | "desc") {
  return (a: RecentVideo, b: RecentVideo): number => {
    const timeA = timeOfVideo(a)
    const timeB = timeOfVideo(b)
    const knownA = Number.isFinite(timeA)
    const knownB = Number.isFinite(timeB)
    if (knownA !== knownB) return knownA ? -1 : 1
    if (knownA && timeA !== timeB) return direction === "asc" ? timeA - timeB : timeB - timeA
    return a.videoId < b.videoId ? -1 : a.videoId > b.videoId ? 1 : 0
  }
}

/** The stream's own event time: actualStart (live) / scheduledStart (upcoming) when the /live-streams source gave it. */
const eventTime = (video: RecentVideo) => timeOf(video.eventAt ?? video.publishedAt)
const publishedTime = (video: RecentVideo) => timeOf(video.publishedAt)

/** Home ALL's order (useHomeAllFeed.ts): ONE global sort by effective time, newest first, across every lifecycle stage --
 * LIVE/UPCOMING/PREMIERE/ARCHIVED/pending-archive priority never overrides it, only each row's own effective timestamp does.
 *
 * The effective timestamp is the SAME `eventTime` every row already carries for its own lifecycle purposes: actualStart for a
 * live stream, scheduledStart for an upcoming stream or Premiere (never its discovery/announcement time -- toRecentVideo never
 * sets eventAt from that), the original Premiere start for a completed Premiere once it is an ordinary archived row (the
 * backend's own audited publish window, read_api.py/collection.youtube_client.py), and the stream's own actualStart/scheduledStart
 * carried unchanged for an archive-pending placeholder (useHomeAllFeed.ts's toPendingRecentVideo) -- its position never jumps when
 * the real archive later replaces it. An ordinary upload/archive with no eventAt falls back to publishedAt, its actual publication
 * datetime. One row per videoId: a stream present in `current` always wins over the same videoId in `archives` (its live/upcoming
 * representation is newer than any stale archive copy), exactly like composeLatestLiveShelf below, just without that function's
 * tiering -- 最新直播 and the Live Status dock keep their own tiered order via composeLatestLiveShelf; this is ALL only. */
export function composeHomeAllFeed(current: RecentVideo[], archives: RecentVideo[]): RecentVideo[] {
  const taken = new Set<string>()
  const takeUnique = (videos: RecentVideo[]) =>
    videos.filter((video) => {
      if (taken.has(video.videoId)) return false
      taken.add(video.videoId)
      return true
    })

  return [...takeUnique(current), ...takeUnique(archives)].sort(compareByTime(eventTime, "desc"))
}

/** 最新直播/the Live Status dock's order: LIVE, then UPCOMING, then an upcoming PREMIERE, then completed archives (this session's
 * B19) -- never the other way round, and never limited/paged away, because `current` comes from GET /live-streams
 * (the canonical live/upcoming source) independently of the archive endpoint's own limit/offset. Home ALL does NOT use this
 * tiering -- see composeHomeAllFeed above.
 *
 * - LIVE: most recently started first (actualStart), videoId as the tie-break.
 * - UPCOMING: nearest scheduledStart first, videoId as the tie-break.
 * - PREMIERE: nearest scheduledStart first, same as UPCOMING -- a Premiere is not a livestream (see toRecentVideo),
 *   but it has not happened yet either, so it sorts the same way, just in its own bucket. Callers that must never
 *   show a Premiere (最新直播, or ALL narrowed to content type "live") are expected to filter `current` themselves
 *   before calling this -- this function does not know which tag it is serving.
 * - ARCHIVED: newest first by `publishedAt` -- the only archive timestamp the archive read model carries (the backend
 *   sorts the same way); videoId as the tie-break. A completed Premiere arrives here indistinguishable from any
 *   other upload, already correctly timestamped at its own Premiere start (collection.youtube_client.py's audited
 *   publish window), never its original announcement time.
 *
 * One row per videoId: a stream present in `current` always wins over the same videoId in `archives` (its live/upcoming
 * representation is newer than any stale archive copy), and a live stream wins over an upcoming copy of itself. */
export function composeLatestLiveShelf(current: RecentVideo[], archives: RecentVideo[]): RecentVideo[] {
  const taken = new Set<string>()
  const takeUnique = (videos: RecentVideo[]) =>
    videos.filter((video) => {
      if (taken.has(video.videoId)) return false
      taken.add(video.videoId)
      return true
    })

  const live = takeUnique(current.filter((video) => video.contentFormat === "live_now")).sort(compareByTime(eventTime, "desc"))
  const upcoming = takeUnique(current.filter((video) => video.contentFormat === "live_upcoming")).sort(compareByTime(eventTime, "asc"))
  const premiere = takeUnique(current.filter((video) => video.contentFormat === "premiere")).sort(compareByTime(eventTime, "asc"))
  const archived = takeUnique(archives).sort(compareByTime(publishedTime, "desc"))

  return [...live, ...upcoming, ...premiere, ...archived]
}
