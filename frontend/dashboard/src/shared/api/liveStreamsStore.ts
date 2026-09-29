import { createSharedState } from "../state/sharedState"
import { acquirePolling } from "./liveStreamsPollState"
import { fetchLiveStreams, type LiveStreamDto } from "./liveStreams"

export interface LiveStreamsState {
  streams: LiveStreamDto[]
  isLoading: boolean
  error: string | null
}

const STORAGE_KEY = "yobi.liveStreams.cache"
const POLL_INTERVAL_MS = 60_000

const INITIAL_STATE: LiveStreamsState = { streams: [], isLoading: true, error: null }

/** Reads the last successfully cached response so a reload shows it
 * immediately while a fresh fetch is in flight, instead of a blank/offline
 * flash -- never presented as settled, `isLoading` is always forced true
 * here regardless of what was cached. */
function readCached(): LiveStreamsState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return INITIAL_STATE
    const parsed = JSON.parse(raw) as LiveStreamsState
    return { ...parsed, isLoading: true }
  } catch {
    return INITIAL_STATE
  }
}

/** The one shared store every /live-streams consumer (Home's
 * useCreatorStatuses, the always-mounted LiveScheduleDock, Schedule's
 * useWeeklySchedule) reads through -- same createSharedState/useSyncExternalStore
 * pattern this project already uses for useSelectedCreator etc.
 * (shared/state/sharedState.ts), so it participates in the same
 * resetAllSharedStateForTests()/afterEach cleanup with no extra test wiring. */
export const liveStreamsStore = createSharedState<LiveStreamsState>(STORAGE_KEY, readCached, (value) =>
  JSON.stringify(value),
)

async function refresh(): Promise<void> {
  try {
    const streams = await fetchLiveStreams()
    liveStreamsStore.set({ streams, isLoading: false, error: null })
  } catch (err) {
    liveStreamsStore.set({ ...liveStreamsStore.get(), isLoading: false, error: err instanceof Error ? err.message : "Unknown error" })
  }
}

/** Ref-counted so exactly one fetch/poll runs no matter how many consumers
 * are mounted at once (e.g. Home's own useCreatorStatuses call plus the
 * globally-mounted LiveScheduleDock's separate call, both on the Home
 * route) -- starts on the first subscriber, stops once the last one
 * unmounts. Returns the unsubscribe function for that caller's own cleanup. */
export function acquireLiveStreamsPolling(): () => void {
  return acquirePolling(POLL_INTERVAL_MS, () => void refresh())
}
