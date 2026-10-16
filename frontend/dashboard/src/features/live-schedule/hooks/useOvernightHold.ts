import { useEffect, useMemo } from "react"
import { getCreatorById } from "../../../entities/creator/data/creatorRegistry"
import type { LiveStreamDto, RecentlyEndedStreamDto } from "../../../shared/api/liveStreams"
import { createSharedState, useSharedState } from "../../../shared/state/sharedState"

/** An overnight stream the Schedule is still waiting on: seen live after the viewer's local midnight had already passed its start. `startMs` is
 * the stream's own start instant (the same instant the grid places it by), so its ORIGINAL local start date is always derived from the
 * viewer's current IANA timezone -- never stored as a date string in some other zone, never JST. */
interface PendingOvernightStream {
  creatorId: string
  startMs: number
  /** When this stream was last observed live (refreshed at most every LAST_SEEN_RESOLUTION_MS). A stream the backend never confirms is forgotten END_SIGNAL_WINDOW_MS after this. */
  lastSeenMs?: number
}

type PendingOvernight = Record<string, PendingOvernightStream>

const STORAGE_KEY = "yobi.schedule.overnightPending"
const NONE: PendingOvernight = {}
/** GET /live-streams lists a confirmed end for 24 hours (RECENTLY_ENDED_EXPOSE in tracking/livestream_lifecycle.py; the end is confirmed within minutes of the
 * stream leaving the live list). A remembered stream not seen live for longer than that can never be told "ended" again, so it is forgotten rather than holding the
 * date forever. Measured from the last time it was SEEN LIVE, not from its start: a stream that ran for days is not forgotten the moment it ends. */
const END_SIGNAL_WINDOW_MS = 24 * 3_600_000
const LAST_SEEN_RESOLUTION_MS = 30 * 60_000
const lastSeenOf = (entry: PendingOvernightStream) => entry.lastSeenMs ?? entry.startMs

function readPending(): PendingOvernight {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return NONE
    const parsed = JSON.parse(raw) as Record<string, Partial<PendingOvernightStream>>
    const valid = Object.entries(parsed).filter(
      (entry): entry is [string, PendingOvernightStream] => typeof entry[1]?.creatorId === "string" && Number.isFinite(entry[1]?.startMs),
    )
    return Object.fromEntries(valid)
  } catch {
    return NONE
  }
}

/** Persisted so a reload (or a closed tab) keeps the held date: a stream that drops out of /live-streams for a moment is no longer in the response,
 * and until the backend CONFIRMS it ended there is nothing else that remembers it. */
const pendingStore = createSharedState<PendingOvernight>(STORAGE_KEY, readPending, (value) => JSON.stringify(value))

/** The instant the grid places `dto` at (scheduledStart, else actualStart -- the rule useWeeklySchedule uses), or null when it can't be placed. */
function placementMs(dto: LiveStreamDto): number | null {
  const startIso = dto.scheduledStart ?? dto.actualStart
  const ms = startIso ? new Date(startIso).getTime() : Number.NaN
  return Number.isNaN(ms) ? null : ms
}

/** Only a MEMBER creator's channel can hold the Schedule date. A group or staff channel (hololive FLOW GLOW, vspo_official, ...) can stay live for
 * days -- a 24/7 station or a long-running event -- so it must never pin the window to its start day. Its streams are still shown, by the normal rule. */
const holdsDate = (creatorId: string) => getCreatorById(creatorId)?.channelType === "member"

/** The viewer's local midnight of the day `ms` falls on. */
function localDayStart(ms: number): Date {
  const at = new Date(ms)
  return new Date(at.getFullYear(), at.getMonth(), at.getDate())
}

/** The local day the Schedule window must START on while an overnight stream is unresolved, or null when nothing is held.
 *
 * Normally the window starts today. A stream that is live after the viewer's local midnight has passed its start (it began on an earlier local day) is
 * "overnight" and is tracked from then on. The returned day is the ORIGINAL local start date of the earliest unresolved one -- it stays put across any
 * number of further midnights and moves forward as streams resolve, finally to today once every one has.
 *
 * Responsibilities, kept separate: this hook depends ONLY on observed live/end state. A stream is resolved when the backend lists it in `recentlyEnded`
 * -- its 5-minute lifecycle verified the end against YouTube -- and never because of anything archive-related (the archive lookup is the backend's
 * other, independent job; its success, failure or delay cannot move the Schedule). Dropping out of /live-streams is NOT an end: the list can lose a
 * stream for a poll, so a dropped stream stays held until the backend confirms it ended.
 *
 * When the backend sends no `recentlyEnded` (undefined: an older deployment, or the field could not be read) there is no end signal to wait for, so
 * nothing is held at all -- the Schedule simply starts today, as it did before this existed -- rather than waiting on a signal that cannot arrive. */
export function useOvernightHold({
  streams,
  recentlyEnded,
  today,
  now,
}: {
  streams: LiveStreamDto[]
  recentlyEnded: RecentlyEndedStreamDto[] | undefined
  today: Date
  now: Date
}): Date | null {
  const [pending, setPending] = useSharedState(pendingStore)
  const supported = recentlyEnded !== undefined
  const todayMs = today.getTime()
  const nowMs = now.getTime()
  const horizonMs = nowMs - END_SIGNAL_WINDOW_MS

  // Live right now with a start before the viewer's local today. Derived during render (not in an effect) so the hold is already in force in the
  // very render that crosses midnight and the window never flickers to the new day and back.
  const liveOvernight = useMemo(
    () =>
      streams.flatMap((dto) => {
        const startMs = placementMs(dto)
        return dto.status === "live" && holdsDate(dto.creatorId) && startMs !== null && startMs < todayMs
          ? [{ videoId: dto.videoId, creatorId: dto.creatorId, startMs }]
          : []
      }),
    [streams, todayMs],
  )

  // Ended per the backend -- unless the stream is live right now (a stale record must never override what is live).
  const resolvedIds = useMemo(() => {
    const liveIds = new Set(streams.map((dto) => dto.videoId))
    return new Set((recentlyEnded ?? []).map((ended) => ended.videoId).filter((videoId) => !liveIds.has(videoId)))
  }, [streams, recentlyEnded])

  // Remember every stream seen live overnight (and its start); forget what the backend has confirmed ended, and what is too old to ever be told.
  useEffect(() => {
    if (!supported) return
    const next: PendingOvernight = {}
    for (const [videoId, entry] of Object.entries(pending)) if (!resolvedIds.has(videoId) && holdsDate(entry.creatorId) && lastSeenOf(entry) >= horizonMs) next[videoId] = entry
    for (const entry of liveOvernight) {
      const seen = next[entry.videoId]?.lastSeenMs
      next[entry.videoId] = { creatorId: entry.creatorId, startMs: entry.startMs, lastSeenMs: seen !== undefined && nowMs - seen < LAST_SEEN_RESOLUTION_MS ? seen : nowMs }
    }
    const same = Object.keys(next).length === Object.keys(pending).length && Object.entries(next).every(([videoId, entry]) => pending[videoId]?.startMs === entry.startMs && pending[videoId]?.lastSeenMs === entry.lastSeenMs)
    if (!same) setPending(next)
  }, [supported, pending, liveOvernight, resolvedIds, horizonMs, nowMs, setPending])

  const earliestStartMs = useMemo(() => {
    if (!supported) return null
    const remembered = Object.entries(pending).filter(([videoId, entry]) => !resolvedIds.has(videoId) && holdsDate(entry.creatorId) && lastSeenOf(entry) >= horizonMs).map(([, entry]) => entry.startMs)
    const starts = [...liveOvernight.map((entry) => entry.startMs), ...remembered].filter((ms) => ms < todayMs)
    return starts.length > 0 ? Math.min(...starts) : null
  }, [supported, liveOvernight, pending, resolvedIds, horizonMs, todayMs])

  return useMemo(() => (earliestStartMs === null ? null : localDayStart(earliestStartMs)), [earliestStartMs])
}