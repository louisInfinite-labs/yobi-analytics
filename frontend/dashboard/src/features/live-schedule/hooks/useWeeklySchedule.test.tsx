import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useWeeklySchedule } from "./useWeeklySchedule"

const TICK_MS = 30_000

/** Local-time constructor on purpose: the hook is user-local, never UTC. */
function startAt(year: number, monthIndex: number, day: number, hour: number, minute: number, second: number) {
  vi.setSystemTime(new Date(year, monthIndex, day, hour, minute, second))
}

function tick() {
  act(() => {
    vi.advanceTimersByTime(TICK_MS)
  })
}

const todayIndex = (days: { isToday: boolean }[]) => days.findIndex((day) => day.isToday)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("useWeeklySchedule week rollover", () => {
  it("keeps the same weekStart object across a status tick within the same local day", () => {
    startAt(2026, 8, 23, 10, 0, 0) // Wed 2026-09-23
    const { result } = renderHook(() => useWeeklySchedule())
    const before = result.current.weekStart

    tick()

    expect(result.current.now.getMinutes()).toBe(0)
    expect(result.current.now.getSeconds()).toBe(30)
    expect(result.current.weekStart).toBe(before)
  })

  it("moves 'today' to the next day at local midnight without changing the week", () => {
    startAt(2026, 8, 23, 23, 59, 40) // Wed 23:59:40
    const { result } = renderHook(() => useWeeklySchedule())
    expect(todayIndex(result.current.days)).toBe(3)
    const weekBefore = result.current.weekStart.getTime()

    tick() // Thu 00:00:10

    expect(todayIndex(result.current.days)).toBe(4)
    expect(result.current.weekStart.getTime()).toBe(weekBefore)
  })

  it("recalculates the displayed week when local midnight crosses the Saturday to Sunday boundary", () => {
    startAt(2026, 8, 26, 23, 59, 40) // Sat 2026-09-26 (last day of the Sun-Sat week)
    const { result } = renderHook(() => useWeeklySchedule())
    expect(result.current.weekStart).toEqual(new Date(2026, 8, 20))
    expect(todayIndex(result.current.days)).toBe(6)

    tick() // Sun 2026-09-27 00:00:10

    expect(result.current.weekStart).toEqual(new Date(2026, 8, 27))
    expect(result.current.weekStart.getDay()).toBe(0)
    expect(todayIndex(result.current.days)).toBe(0)
    expect(result.current.days[6].date).toEqual(new Date(2026, 9, 3))
  })

  it("keeps a non-zero weekOffset relative to the newly current local week", () => {
    startAt(2026, 8, 26, 23, 59, 40) // Sat 2026-09-26
    const { result } = renderHook(() => useWeeklySchedule())
    act(() => result.current.goToNextWeek())
    expect(result.current.weekStart).toEqual(new Date(2026, 8, 27))

    tick() // now Sun 2026-09-27 00:00:10 -> current week starts 09-27, so +1 week is 10-04

    expect(result.current.weekStart).toEqual(new Date(2026, 9, 4))
  })
})
