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

/** 最新直播's order: LIVE, then UPCOMING, then completed archives (this session's B19) -- never the other way
 * round, and never limited/paged away, because `current` comes from GET /live-streams (the canonical live/upcoming
 * source) independently of the archive endpoint's own limit/offset.
 *
 * - LIVE: most recently started first (actualStart), videoId as the tie-break.
 * - UPCOMING: nearest scheduledStart first, videoId as the tie-break.
 * - ARCHIVED: newest first by `publishedAt` -- the only archive timestamp the archive read model carries (the backend
 *   sorts the same way); videoId as the tie-break.
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
  const archived = takeUnique(archives).sort(compareByTime(publishedTime, "desc"))

  return [...live, ...upcoming, ...archived]
}
