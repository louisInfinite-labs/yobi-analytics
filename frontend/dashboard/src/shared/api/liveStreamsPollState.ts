import { startJitteredInterval } from "./jitter"

let subscriberCount = 0
let cancelInterval: (() => void) | null = null

/** Ref-counted shared interval: `tick` runs once immediately (never delayed) and then roughly every
 * `intervalMs` (jittered, see jitter.ts) while at least one subscriber is acquired, regardless of how
 * many consumers overlap -- starts on the first, stops after the last.
 * Deliberately dependency-free (no fetch/apiClient import) so
 * resetLiveStreamsPollingForTests can be wired into the global test setup
 * file without that setup eagerly importing -- and so accidentally
 * poisoning any individual test file's own `vi.mock` of -- the real
 * network-fetching modules built on top of this (liveStreamsStore.ts). */
export function acquirePolling(intervalMs: number, tick: () => void): () => void {
  subscriberCount += 1
  if (subscriberCount === 1) {
    tick()
    cancelInterval = startJitteredInterval(tick, intervalMs)
  }
  return () => {
    subscriberCount -= 1
    if (subscriberCount === 0 && cancelInterval !== null) {
      cancelInterval()
      cancelInterval = null
    }
  }
}

/** Test-only: resets this module-level ref count/interval between tests --
 * same singleton-leaks-across-tests problem useLiveDockExpanded's own
 * resetLiveDockExpandedForTests solves. */
export function resetLiveStreamsPollingForTests(): void {
  if (cancelInterval !== null) cancelInterval()
  cancelInterval = null
  subscriberCount = 0
}
