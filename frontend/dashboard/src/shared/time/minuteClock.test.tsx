import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useMinuteClock } from "./minuteClock"
import { formatCountdown } from "../../features/live-status/model/creatorStatusFormat"

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const at = (hour: number, minute: number, second: number, ms = 0) => new Date(2026, 9, 10, hour, minute, second, ms)

describe("useMinuteClock", () => {
  it("ticks exactly at wall-clock minute boundaries, not every 30 s from mount", () => {
    vi.setSystemTime(at(4, 30, 20))
    const { result } = renderHook(() => useMinuteClock())
    const first = result.current

    act(() => void vi.advanceTimersByTime(39_000)) // 04:30:59 -- still inside the minute
    expect(result.current).toBe(first)

    act(() => void vi.advanceTimersByTime(1_100)) // just past 04:31:00
    expect(result.current).not.toBe(first)
    expect(result.current.getMinutes()).toBe(31)
    expect(result.current.getSeconds()).toBe(0)
  })

  it("every consumer mounted at ANY phase gets the same value at the same instant (two pages cannot disagree)", () => {
    vi.setSystemTime(at(4, 30, 5))
    const home = renderHook(() => useMinuteClock())
    act(() => void vi.advanceTimersByTime(23_000)) // the Schedule page mounts 23 s later, at a different phase
    const schedule = renderHook(() => useMinuteClock())

    expect(schedule.result.current.getTime()).toBeGreaterThanOrEqual(home.result.current.getTime())
    act(() => void vi.advanceTimersByTime(60_000))
    expect(home.result.current).toBe(schedule.result.current) // the very same Date object
    const start = at(6, 0, 0).toISOString()
    expect(formatCountdown(start, home.result.current, "en")).toBe(formatCountdown(start, schedule.result.current, "en"))
  })

  it("a countdown to a minute-aligned start changes exactly once per minute, at the boundary, for everyone", () => {
    vi.setSystemTime(at(4, 29, 40))
    const start = at(6, 0, 0).toISOString()
    const { result } = renderHook(() => useMinuteClock())
    const shown: string[] = []
    for (let step = 0; step < 6; step += 1) {
      shown.push(formatCountdown(start, result.current, "en"))
      act(() => void vi.advanceTimersByTime(30_000))
    }
    // sampled at 04:29:40, :30:10, :30:40, :31:10, :31:40, :32:10 -- always the true floor of the remaining time, never a stale minute
    expect(shown).toEqual(["In 1h:30m", "In 1h:29m", "In 1h:29m", "In 1h:28m", "In 1h:28m", "In 1h:27m"])
  })

  it("stops its timer when nobody is subscribed and starts from a fresh value on the next mount", () => {
    vi.setSystemTime(at(4, 30, 0))
    const view = renderHook(() => useMinuteClock())
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)

    vi.setSystemTime(at(9, 12, 34)) // much later
    const again = renderHook(() => useMinuteClock())
    expect(again.result.current.getHours()).toBe(9)
    expect(again.result.current.getMinutes()).toBe(12)
  })
})
