import { describe, expect, it } from "vitest"
import { dueAttempt, FRESH_IFRAME_GRACE_MS, msUntilNextAttempt, RECOVERY_OFFSETS_MS } from "./upcomingStartRecovery"

const START = Date.UTC(2026, 9, 16, 12, 15, 0) // 21:15 JST
const LAST = RECOVERY_OFFSETS_MS[RECOVERY_OFFSETS_MS.length - 1]

describe("the recovery schedule is fixed and finite", () => {
  it("is a short, strictly increasing list -- the whole bound on how often a stuck waiting screen is retried", () => {
    expect(RECOVERY_OFFSETS_MS.length).toBeLessThanOrEqual(12)
    expect(RECOVERY_OFFSETS_MS.every((offset, index) => index === 0 || offset > RECOVERY_OFFSETS_MS[index - 1])).toBe(true)
  })

  it("nothing is due before the scheduled start; the first attempt is due 5 s after it", () => {
    const base = { startMs: START, mountedAt: START - 600_000, attemptsDone: 0 }
    expect(dueAttempt({ ...base, now: START - 1 }).due).toBe(false)
    expect(dueAttempt({ ...base, now: START + 4_999 }).due).toBe(false)
    expect(dueAttempt({ ...base, now: START + 5_000 })).toEqual({ due: true, nextAttemptsDone: 1 })
    expect(msUntilNextAttempt({ ...base, now: START - 60_000 })).toBe(65_000)
  })

  it("every attempt is used at most once, and after the last one nothing is ever due again", () => {
    let done = 0
    let attempts = 0
    for (let now = START; now <= START + LAST * 3; now += 1_000) {
      const result = dueAttempt({ now, startMs: START, mountedAt: START - 600_000, attemptsDone: done })
      if (result.due) attempts += 1
      done = result.nextAttemptsDone
    }
    expect(attempts).toBe(RECOVERY_OFFSETS_MS.length)
    expect(msUntilNextAttempt({ now: START + LAST * 3, startMs: START, mountedAt: START - 600_000, attemptsDone: done })).toBeNull()
  })

  it("several due at once (a suspended background tab) collapse into ONE attempt", () => {
    const result = dueAttempt({ now: START + 200_000, startMs: START, mountedAt: START - 600_000, attemptsDone: 0 })
    expect(result).toEqual({ due: true, nextAttemptsDone: 5 }) // 5 s, 20 s, 45 s, 90 s and 180 s are all past -- one call, all five consumed
  })

  it("a freshly mounted iframe is never touched inside its grace period, whatever the start time says", () => {
    const mountedAt = START + 100_000
    expect(dueAttempt({ now: mountedAt + FRESH_IFRAME_GRACE_MS - 1, startMs: START, mountedAt, attemptsDone: 0 }).due).toBe(false)
    expect(dueAttempt({ now: mountedAt + FRESH_IFRAME_GRACE_MS, startMs: START, mountedAt, attemptsDone: 0 }).due).toBe(true)
  })

  it("an iframe mounted long after the start (well past the last offset) is left alone; one open since BEFORE the start still gets its catch-up", () => {
    const farLater = START + LAST + FRESH_IFRAME_GRACE_MS + 1
    expect(dueAttempt({ now: farLater, startMs: START, mountedAt: farLater - 60_000, attemptsDone: 0 }).due).toBe(false)
    expect(msUntilNextAttempt({ now: farLater, startMs: START, mountedAt: farLater - 60_000, attemptsDone: 0 })).toBeNull()
    expect(dueAttempt({ now: START + 3 * 3_600_000, startMs: START, mountedAt: START - 600_000, attemptsDone: 0 })).toEqual({
      due: true,
      nextAttemptsDone: RECOVERY_OFFSETS_MS.length,
    })
  })
})
