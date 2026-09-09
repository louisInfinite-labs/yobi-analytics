import { renderHook, act } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useCountdownLanguage } from "./useCountdownLanguage"

describe("useCountdownLanguage", () => {
  it("defaults to a supported language derived from the browser locale", () => {
    const { result } = renderHook(() => useCountdownLanguage())
    expect(["zh", "en", "ja"]).toContain(result.current[0])
  })

  it("persists an explicit choice across hook instances", () => {
    const first = renderHook(() => useCountdownLanguage())
    act(() => first.result.current[1]("zh"))

    const second = renderHook(() => useCountdownLanguage())
    expect(second.result.current[0]).toBe("zh")
  })
})
