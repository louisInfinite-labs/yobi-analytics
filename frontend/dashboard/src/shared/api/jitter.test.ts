import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { acquirePolling, resetLiveStreamsPollingForTests } from "./liveStreamsPollState"
import { jitteredDelay, POLL_JITTER_FRACTION, startJitteredInterval } from "./jitter"

describe("jitteredDelay", () => {
  it("stays within +/- the jitter fraction of the base and hits both bounds", () => {
    expect(jitteredDelay(60_000, () => 0)).toBe(60_000 * (1 - POLL_JITTER_FRACTION))
    expect(jitteredDelay(60_000, () => 0.5)).toBe(60_000)
    expect(jitteredDelay(60_000, () => 1)).toBe(60_000 * (1 + POLL_JITTER_FRACTION))
    for (let i = 0; i < 200; i++) {
      const delay = jitteredDelay(60_000)
      expect(delay).toBeGreaterThanOrEqual(48_000)
      expect(delay).toBeLessThanOrEqual(72_000)
    }
  })

  it("actually varies (it is not a constant)", () => {
    const delays = new Set(Array.from({ length: 50 }, () => jitteredDelay(60_000)))
    expect(delays.size).toBeGreaterThan(10)
  })
})

describe("startJitteredInterval", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("never runs the tick itself first, repeats, and stops on cancel", () => {
    const tick = vi.fn()
    const cancel = startJitteredInterval(tick, 1_000, () => 0.5)

    expect(tick).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(tick).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2_000)
    expect(tick).toHaveBeenCalledTimes(3)

    cancel()
    vi.advanceTimersByTime(10_000)
    expect(tick).toHaveBeenCalledTimes(3)
  })
})

describe("acquirePolling jitter", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    resetLiveStreamsPollingForTests()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("runs the first tick immediately even when the random draw is at its maximum", () => {
    vi.spyOn(Math, "random").mockReturnValue(1)
    const tick = vi.fn()

    acquirePolling(60_000, tick)

    expect(tick).toHaveBeenCalledTimes(1)
  })
})
