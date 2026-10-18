import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { jstDayStartMs, useJstDayStart } from "./jstDay"

const jst = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) => Date.UTC(year, month - 1, day, hour, minute, second) - 9 * 3600 * 1000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
})

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
})

describe("jstDayStartMs", () => {
  it("is 00:00:00 JST of the JST day containing the instant", () => {
    expect(jstDayStartMs(jst(2027, 3, 22, 0, 0, 0))).toBe(jst(2027, 3, 22))
    expect(jstDayStartMs(jst(2027, 3, 22, 23, 59, 59))).toBe(jst(2027, 3, 22))
    expect(jstDayStartMs(jst(2027, 3, 22) - 1)).toBe(jst(2027, 3, 21))
  })
})

describe("useJstDayStart", () => {
  it("changes only at JST midnight, with one timer aimed at it", async () => {
    vi.setSystemTime(jst(2027, 3, 21, 23, 59, 30))
    const { result } = renderHook(() => useJstDayStart())
    expect(result.current).toBe(jst(2027, 3, 21))
    expect(vi.getTimerCount()).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000)
    })
    expect(result.current).toBe(jst(2027, 3, 21))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(result.current).toBe(jst(2027, 3, 22))
    expect(vi.getTimerCount()).toBe(1)
  })

  it("re-reads the day when the tab becomes visible, and stops its timer while hidden or unmounted", () => {
    vi.setSystemTime(jst(2027, 3, 21, 12))
    const { result, unmount } = renderHook(() => useJstDayStart())
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(vi.getTimerCount()).toBe(0)
    vi.setSystemTime(jst(2027, 3, 24, 8))
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(result.current).toBe(jst(2027, 3, 24))
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("also re-reads on window focus and page restore", () => {
    vi.setSystemTime(jst(2027, 3, 21, 12))
    const { result } = renderHook(() => useJstDayStart())
    vi.setSystemTime(jst(2027, 3, 22, 1))
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    expect(result.current).toBe(jst(2027, 3, 22))
    vi.setSystemTime(jst(2027, 3, 23, 1))
    act(() => {
      window.dispatchEvent(new Event("pageshow"))
    })
    expect(result.current).toBe(jst(2027, 3, 23))
  })
})