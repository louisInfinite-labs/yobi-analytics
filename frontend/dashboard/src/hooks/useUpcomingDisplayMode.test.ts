import { renderHook, act } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useUpcomingDisplayMode } from "./useUpcomingDisplayMode"

describe("useUpcomingDisplayMode", () => {
  it("defaults to absolute when nothing is saved", () => {
    const { result } = renderHook(() => useUpcomingDisplayMode())
    expect(result.current[0]).toBe("absolute")
  })

  it("persists the setting across hook instances (one global setting, not per-view)", () => {
    const first = renderHook(() => useUpcomingDisplayMode())
    act(() => first.result.current[1]("countdown"))

    const second = renderHook(() => useUpcomingDisplayMode())
    expect(second.result.current[0]).toBe("countdown")
  })
})
