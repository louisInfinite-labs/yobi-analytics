/** When (relative to a stream's scheduled start) the already-open player may be asked, at most once each, to pick up a broadcast that has begun.
 * Fixed and finite on purpose: it is the whole bound on how often a stuck waiting screen is retried (never a loop). The spacing widens because a creator
 * who is late is usually late by minutes, not seconds. */
export const RECOVERY_OFFSETS_MS: readonly number[] = [5_000, 20_000, 45_000, 90_000, 180_000, 360_000, 600_000, 900_000, 1_500_000, 2_400_000]

/** A freshly loaded iframe reports UNSTARTED for a moment while it boots; no attempt is made on it earlier than this after it was mounted. */
export const FRESH_IFRAME_GRACE_MS = 15_000

/** An iframe mounted AFTER the scheduled start is a fresh load of whatever YouTube shows now, so it only needs help while the creator is plausibly still late:
 * past the last offset (plus the mount grace) it is left alone. An iframe that was already open BEFORE the start has no such cutoff -- a tab returning from
 * the background hours later still gets its (single, collapsed) catch-up attempt. */
function pastRecoveryWindow(now: number, startMs: number, mountedAt: number): boolean {
  const mountedBeforeStart = mountedAt <= startMs
  return !mountedBeforeStart && now > startMs + RECOVERY_OFFSETS_MS[RECOVERY_OFFSETS_MS.length - 1] + FRESH_IFRAME_GRACE_MS
}

/** The attempts that have come due: the offsets from `attemptsDone` on whose time (start + offset, and not before the mount grace) is now or past.
 * Several due at once (a suspended background tab, a late mount) collapse into ONE attempt, and `nextAttemptsDone` skips all of them. */
export function dueAttempt(input: { now: number; startMs: number; mountedAt: number; attemptsDone: number }): { due: boolean; nextAttemptsDone: number } {
  const { now, startMs, mountedAt, attemptsDone } = input
  if (pastRecoveryWindow(now, startMs, mountedAt)) return { due: false, nextAttemptsDone: RECOVERY_OFFSETS_MS.length }
  let next = attemptsDone
  while (next < RECOVERY_OFFSETS_MS.length && Math.max(startMs + RECOVERY_OFFSETS_MS[next], mountedAt + FRESH_IFRAME_GRACE_MS) <= now) next += 1
  return { due: next > attemptsDone, nextAttemptsDone: next }
}

/** Milliseconds until the next attempt is due, or null when every attempt has been used. Never negative. */
export function msUntilNextAttempt(input: { now: number; startMs: number; mountedAt: number; attemptsDone: number }): number | null {
  const { now, startMs, mountedAt, attemptsDone } = input
  if (attemptsDone >= RECOVERY_OFFSETS_MS.length || pastRecoveryWindow(now, startMs, mountedAt)) return null
  return Math.max(0, Math.max(startMs + RECOVERY_OFFSETS_MS[attemptsDone], mountedAt + FRESH_IFRAME_GRACE_MS) - now)
}
