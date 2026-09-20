import { renderHook, act } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useLocale } from "./useLocale"

describe("useLocale", () => {
  it("defaults to one of the three prepared locales when nothing is stored", () => {
    const { result } = renderHook(() => useLocale())
    expect(["zh-TW", "en", "ja"]).toContain(result.current[0])
  })

  it("persists an explicit choice across hook instances", () => {
    const first = renderHook(() => useLocale())
    act(() => first.result.current[1]("ja"))

    const second = renderHook(() => useLocale())
    expect(second.result.current[0]).toBe("ja")
  })

  it("updates an already-mounted consumer immediately when another mounted consumer changes the locale — no remount required", () => {
    // Ready for a future App Language setting: changing it from one mounted
    // consumer must update every other mounted consumer in the same tab
    // right away, not only after a remount.
    const first = renderHook(() => useLocale())
    const second = renderHook(() => useLocale())

    act(() => {
      first.result.current[1]("zh-TW")
    })

    expect(first.result.current[0]).toBe("zh-TW")
    expect(second.result.current[0]).toBe("zh-TW")
  })
})
