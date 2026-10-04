import type { LiveStreamDto } from "../../../shared/api/liveStreams"
import type { CreatorStatus } from "./creatorStatus"

/** Live Status only shows an upcoming stream starting within the next rolling
 * 24 hours. GET /live-streams (and so the shared store) carries a 7-day
 * window because the Schedule page needs it; that wider list is never
 * narrowed in the store or the backend -- only this Live Status selection is. */
export const LIVE_STATUS_UPCOMING_WINDOW_MS = 24 * 60 * 60 * 1000

/** True when `scheduledStart` is after `now` and at most 24 hours after it
 * (exactly +24h is included). Compares absolute instants, so any ISO-8601
 * offset ("Z", "+09:00", ...) is handled by Date parsing; an unparseable or
 * missing timestamp is never inside the window. */
export function isWithinLiveStatusUpcomingWindow(scheduledStart: string | null, now: Date): boolean {
  if (scheduledStart === null) return false
  const startMs = new Date(scheduledStart).getTime()
  if (!Number.isFinite(startMs)) return false
  const nowMs = now.getTime()
  return startMs > nowMs && startMs <= nowMs + LIVE_STATUS_UPCOMING_WINDOW_MS
}

/** One creator's Live Status: a live stream always wins (no time limit);
 * otherwise the nearest upcoming stream inside the next 24 hours; otherwise
 * offline (spec, same priority creatorStatus.ts documents). `now` is the one
 * instant the whole selection is evaluated against, so a boundary is decided
 * once, not re-read per stream. */
export function pickStatus(streams: LiveStreamDto[] | undefined, now: Date): CreatorStatus {
  if (!streams || streams.length === 0) return { kind: "offline" }

  const live = streams.find((stream) => stream.status === "live")
  if (live) return { kind: "live", videoId: live.videoId, title: live.title }

  const nearestUpcoming = streams
    .filter(
      (stream): stream is LiveStreamDto & { scheduledStart: string } =>
        stream.status === "upcoming" && isWithinLiveStatusUpcomingWindow(stream.scheduledStart, now),
    )
    .sort((a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime())[0]
  if (nearestUpcoming) {
    return { kind: "upcoming", videoId: nearestUpcoming.videoId, title: nearestUpcoming.title, scheduledStart: nearestUpcoming.scheduledStart }
  }

  return { kind: "offline" }
}
