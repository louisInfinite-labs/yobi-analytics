import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { mockCreators } from "../data/mockCreators"
import { resetAllSharedStateForTests } from "../lib/sharedState"
import { useDefaultOshiCreator } from "./useDefaultOshiCreator"

describe("useDefaultOshiCreator", () => {
  it("defaults to the first known creator", () => {
    const { result } = renderHook(() => useDefaultOshiCreator())
    expect(result.current[0]).toBe(mockCreators[0].channelId)
  })

  it("persists across hook instances mounted after the change", () => {
    const first = renderHook(() => useDefaultOshiCreator())
    act(() => first.result.current[1]("ch_gawr_gura"))

    const second = renderHook(() => useDefaultOshiCreator())
    expect(second.result.current[0]).toBe("ch_gawr_gura")
  })

  it("updates an already-mounted consumer immediately when another mounted consumer picks a new default -- no remount required", () => {
    const settingsPage = renderHook(() => useDefaultOshiCreator())
    const otherConsumer = renderHook(() => useDefaultOshiCreator())

    act(() => {
      settingsPage.result.current[1]("ch_gawr_gura")
    })

    expect(settingsPage.result.current[0]).toBe("ch_gawr_gura")
    expect(otherConsumer.result.current[0]).toBe("ch_gawr_gura")
  })

  it("falls back to the default creator when localStorage holds an ineligible creator id (e.g. VSPO's own official channel)", () => {
    window.localStorage.setItem("yobi.defaultOshiCreatorId", "ch_vspo_group")
    // The store is a module-level singleton that already read localStorage
    // once at import time (see sharedState.ts) -- re-read it now that
    // localStorage has changed, same as sharedState.test.tsx's own
    // "resetAllSharedStateForTests re-reads every store" case.
    resetAllSharedStateForTests()
    const { result } = renderHook(() => useDefaultOshiCreator())
    expect(result.current[0]).toBe(mockCreators[0].channelId)
  })
})
