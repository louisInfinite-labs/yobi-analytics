import { useSyncExternalStore } from "react"

interface SelectedVideo {
  videoId: string
  title: string
}

interface State {
  creatorId: string | null
  video: SelectedVideo | null
}

let state: State = { creatorId: null, video: null }
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The one canonical way anything in the app selects a video into Home's
 * central Oshi Stream player -- Oshi Videos, Recent Activity, and Live
 * Status (when Home is the active page) all call this instead of each
 * keeping its own competing player state, the same way useLiveDockExpanded
 * is the one shared "is the dock open" signal rather than a per-consumer
 * copy. `creatorId` is the video's own creator, which is what lets
 * useHomeSelectedVideo's read side (below) drop a stale previous-creator
 * pick on its own once currentOshi has moved on, without this module or any
 * caller needing separate reset bookkeeping. */
export function selectHomeVideo(video: SelectedVideo, creatorId: string): void {
  state = { creatorId, video }
  notify()
}

/** Home's own selected video for `creatorId` -- null once `creatorId` no
 * longer matches whichever creator the last selection was made for (i.e.
 * currentOshi has since changed), so the central player falls back to that
 * new creator's own auto-selected live/latest video instead of showing a
 * previous creator's pick. Deliberately NOT built on shared/state/
 * sharedState.ts's createSharedState (same reasoning as
 * useLiveDockExpanded): this is transient UI state, not a saved preference,
 * so a reload must not bring a stale selection back. */
export function useHomeSelectedVideo(creatorId: string): SelectedVideo | null {
  return useSyncExternalStore(subscribe, () => (state.creatorId === creatorId ? state.video : null))
}

/** Test-only: resets the module-level singleton between tests (same
 * singleton-leaks-across-tests problem useLiveDockExpanded's own
 * resetLiveDockExpandedForTests solves). */
export function resetHomeSelectedVideoForTests(): void {
  state = { creatorId: null, video: null }
}
