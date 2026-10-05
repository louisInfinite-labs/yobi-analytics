/** Jitter for PERIODIC / background timers only (SEC-API-003, roadmap MT-15).
 *
 * Spreads synchronized timer waves (many tabs polling on the same 60 s cadence after a deploy, an outage or a device
 * wake) so the API's small burst capacity suffices. It is deliberately NOT applied to the initial page-load request,
 * an explicit user-triggered fetch or a navigation-triggered load: those must never feel slower. Only the delay
 * BETWEEN repeats is randomized. */
export const POLL_JITTER_FRACTION = 0.2

/** `baseMs` ± POLL_JITTER_FRACTION, uniformly distributed (`random` is injectable for tests). */
export function jitteredDelay(baseMs: number, random: () => number = Math.random): number {
  const spread = baseMs * POLL_JITTER_FRACTION
  return Math.round(baseMs - spread + random() * 2 * spread)
}

/** Runs `tick` repeatedly with a jittered delay between runs and returns a cancel function. It does NOT call `tick`
 * itself first: the caller decides whether the first run is immediate (it should be, for page load). */
export function startJitteredInterval(tick: () => void, baseMs: number, random: () => number = Math.random): () => void {
  let handle: ReturnType<typeof setTimeout> | null = null
  let cancelled = false
  const schedule = () => {
    handle = setTimeout(() => {
      if (cancelled) return
      tick()
      schedule()
    }, jitteredDelay(baseMs, random))
  }
  schedule()
  return () => {
    cancelled = true
    if (handle !== null) clearTimeout(handle)
    handle = null
  }
}
