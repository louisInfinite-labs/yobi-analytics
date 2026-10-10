import { useCallback, useMemo } from "react"
import { createSharedState, useSharedState } from "../state/sharedState"

/** NEW tags for content (videos and livestream archives). The NEW badge is displayed ONLY in the Oshi Status recent
 * activity; Home's Video List shows no badge but shares the same seen state, so opening an item in either clears it
 * from Oshi Status.
 *
 * Semantics (browser/device-local; there is no login or sync):
 * - Tracking starts on the first ever use on this browser. The baseline is 00:00 LOCAL time of that first-use
 *   day (the browser's actual time zone, never a hardcoded one) and is written once -- it is never rewritten on
 *   later loads, so a reload, a navigation or a new day cannot move it.
 * - An item is NEW while its event time is at or after the baseline (and not in the future) and it has not been
 *   explicitly opened. Visiting a page never clears NEW; only markContentSeen(videoId) does, keyed by videoId.
 *
 * Event-time precedence (see newContentEventTime): the stream's real start (`eventAt`, from /live-streams'
 * actualStart, else scheduledStart) when the source exposes it, otherwise YouTube's `publishedAt`.
 *
 * A livestream is never NEW while it is upcoming or live; it can only become NEW once it is an archive. If the user
 * already watched it DURING the live session (the embedded player reported PLAYING for that videoId, see
 * markWatchedDuringLive), its later archive is not NEW either. While the stream is live that is a temporary
 * `watchedDuringLive` marker, separate from `seen` (which only an explicit open writes): both suppress NEW, but they
 * come from different user actions. The first time the same video is observed as a COMPLETED archive
 * (migrateWatchedLiveToSeen) the marker becomes a permanent `seen` entry and is deleted -- "watched while live" turns
 * into "already consumed content", so the knowledge never expires and can never resurface as a false NEW. */

const BASELINE_STORAGE_KEY = "yobi.newContent.trackingBaselineAt"
const SEEN_STORAGE_KEY = "yobi.newContent.seenVideoIds"
const WATCHED_LIVE_STORAGE_KEY = "yobi.newContent.watchedDuringLive"

/** Upper bound on remembered opened ids so localStorage stays small; the oldest ids are dropped first. */
const MAX_SEEN_IDS = 2000

/** A watched-during-live marker has NO expiry: it stays until the stream is observed as a completed archive (then it
 * migrates into `seen`). Only a hard cap keeps storage bounded -- 500 live streams watched and never yet seen as an
 * archive -- and then the oldest marker is dropped first. */
const MAX_WATCHED_LIVE_IDS = 500

/** 00:00:00.000 of `date`'s calendar day in the browser's own local time zone. */
export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
}

/** The stored baseline as an ISO instant, or the first-use baseline (today's local midnight) -- written to
 * storage so it survives every later load. A storage failure just means the baseline is recomputed next load. */
function readOrInitBaseline(): string {
  try {
    const stored = window.localStorage.getItem(BASELINE_STORAGE_KEY)
    if (stored && !Number.isNaN(new Date(stored).getTime())) return stored
  } catch {
    // Unreadable storage: fall through to a first-use baseline for this session.
  }
  const baseline = startOfLocalDay(new Date()).toISOString()
  try {
    window.localStorage.setItem(BASELINE_STORAGE_KEY, baseline)
  } catch {
    // Best-effort, like every other localStorage writer in this app.
  }
  return baseline
}

function readSeen(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SEEN_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === "string")) : new Set()
  } catch {
    return new Set()
  }
}

/** videoId -> epoch ms of its first confirmed PLAYING while live; insertion order is oldest-first. */
type WatchedLive = ReadonlyMap<string, number>

function readWatchedLive(): WatchedLive {
  try {
    const raw = window.localStorage.getItem(WATCHED_LIVE_STORAGE_KEY)
    if (!raw) return new Map()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Map()
    const entries: [string, number][] = []
    for (const item of parsed) {
      if (Array.isArray(item) && typeof item[0] === "string" && item[0] && typeof item[1] === "number" && Number.isFinite(item[1])) {
        entries.push([item[0], item[1]])
      }
    }
    return new Map(entries)
  } catch {
    return new Map()
  }
}

const baselineStore = createSharedState<string>(BASELINE_STORAGE_KEY, readOrInitBaseline, (value) => value)
const seenStore = createSharedState<Set<string>>(SEEN_STORAGE_KEY, readSeen, (value) => JSON.stringify([...value]))
const watchedLiveStore = createSharedState<WatchedLive>(WATCHED_LIVE_STORAGE_KEY, readWatchedLive, (value) => JSON.stringify([...value]))

/** What a list row needs to know to be judged NEW. */
export interface NewContentCandidate {
  videoId: string
  /** YouTube's publishedAt -- for a livestream this is when the broadcast was created/scheduled, not when it ran. */
  publishedAt: string
  /** The stream's real start (actualStart, else scheduledStart) when the data source exposes it. */
  eventAt?: string | null
  /** An upcoming stream has not happened yet, so it is never NEW. */
  contentFormat?: string
}

/** The moment the content event happened, in epoch ms, or null when unknown/unparseable.
 * Precedence: `eventAt` (the stream's actual start, else its scheduled start) over `publishedAt`. Only the
 * livestream sources that expose a real start time (GET /live-streams) can supply `eventAt`; the archive and
 * oshi-status read models carry `publishedAt` alone. */
export function newContentEventTime(candidate: NewContentCandidate): number | null {
  for (const value of [candidate.eventAt, candidate.publishedAt]) {
    if (!value) continue
    const time = new Date(value).getTime()
    if (Number.isFinite(time)) return time
  }
  return null
}

/** Pure NEW decision: not an upcoming/live stream, not opened yet, not watched while it was live, event at/after the
 * tracking baseline, and already happened. */
export function isNewContent(
  candidate: NewContentCandidate,
  state: { baseline: string; seen: ReadonlySet<string>; watchedDuringLive?: ReadonlySet<string>; now: Date },
): boolean {
  if (candidate.contentFormat === "live_upcoming" || candidate.contentFormat === "live_now") return false
  if (state.seen.has(candidate.videoId)) return false
  if (state.watchedDuringLive?.has(candidate.videoId)) return false
  const baseline = new Date(state.baseline).getTime()
  const eventTime = newContentEventTime(candidate)
  if (!Number.isFinite(baseline) || eventTime === null) return false
  return eventTime >= baseline && eventTime <= state.now.getTime()
}

/** Explicitly opening an item clears its NEW state everywhere. Idempotent; other items are untouched. */
export function markContentSeen(videoId: string): void {
  const current = seenStore.get()
  if (!videoId || current.has(videoId)) return
  const next = new Set(current)
  next.add(videoId)
  while (next.size > MAX_SEEN_IDS) next.delete(next.values().next().value as string)
  seenStore.set(next)
}

/** Records that the user watched this livestream DURING the live session. Callers must only invoke it after the
 * embedded YouTube player reported PLAYING for a stream that is live right now -- never for a page open, an
 * automatic creator selection, an iframe/videoId assignment or an autoplay attempt (see useWatchedDuringLive).
 * Idempotent: the first confirmation wins and its time is never refreshed. The count is capped (oldest first). */
export function markWatchedDuringLive(videoId: string): void {
  const current = watchedLiveStore.get()
  if (!videoId || current.has(videoId)) return
  const next = new Map(current)
  next.set(videoId, Date.now())
  while (next.size > MAX_WATCHED_LIVE_IDS) next.delete(next.keys().next().value as string)
  watchedLiveStore.set(next)
}

/** Call with the ids of videos just observed as COMPLETED archives (never live/upcoming ones). Every id that carries
 * a watched-during-live marker is permanently added to the shared `seen` set and its marker is removed. `seen` is
 * written first, so the video is suppressed by `seen` before the marker goes and no render in between can show it NEW.
 * Ids without a marker are ignored; calling it again is a no-op. */
export function migrateWatchedLiveToSeen(archivedVideoIds: Iterable<string>): void {
  const watched = watchedLiveStore.get()
  if (watched.size === 0) return
  const migrating = [...new Set(archivedVideoIds)].filter((videoId) => watched.has(videoId))
  if (migrating.length === 0) return
  migrating.forEach(markContentSeen)
  const remaining = new Map(watched)
  migrating.forEach((videoId) => remaining.delete(videoId))
  watchedLiveStore.set(remaining)
}

/** DEV-only: simulates "first use today" -- baseline back to today's local 00:00 and every opened item and
 * watched-during-live marker forgotten, so today's content is NEW again. No-op outside dev. */
export function resetNewContentTracking(): void {
  if (!import.meta.env.DEV) return
  baselineStore.set(startOfLocalDay(new Date()).toISOString())
  seenStore.set(new Set())
  watchedLiveStore.set(new Map())
}

/** Reactive NEW judgement for list rows. Every consumer shares the same stores, so opening an item in one list
 * re-renders the others immediately. `now` defaults to the render time. */
export function useNewContent() {
  const [baseline] = useSharedState(baselineStore)
  const [seen] = useSharedState(seenStore)
  const [watchedLive] = useSharedState(watchedLiveStore)
  const watchedDuringLive = useMemo(() => new Set(watchedLive.keys()), [watchedLive])
  const isNew = useCallback(
    (candidate: NewContentCandidate, now: Date = new Date()) => isNewContent(candidate, { baseline, seen, watchedDuringLive, now }),
    [baseline, seen, watchedDuringLive],
  )
  return useMemo(() => ({ isNew, markSeen: markContentSeen }), [isNew])
}
