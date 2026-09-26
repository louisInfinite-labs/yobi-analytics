import { renderHook } from "@testing-library/react"
import { act } from "react"
import { beforeEach, describe, expect, it } from "vitest"
import { resetHomeSelectedVideoForTests, selectHomeVideo, useHomeSelectedVideo } from "./useHomeSelectedVideo"

describe("useHomeSelectedVideo", () => {
  // This module-level singleton isn't one of test/setup.ts's own resets
  // (that file resets it globally for every OTHER test in the suite), but
  // resetting it here too keeps this describe block's own tests independent
  // of each other and of run order.
  beforeEach(() => {
    resetHomeSelectedVideoForTests()
  })

  it("is null before any selection", () => {
    const { result } = renderHook(() => useHomeSelectedVideo("ch_aizawa_ema"))
    expect(result.current).toBeNull()
  })

  it("returns the selected video for the creator it was selected for", () => {
    const { result } = renderHook(() => useHomeSelectedVideo("ch_aizawa_ema"))
    act(() => selectHomeVideo({ videoId: "v1", title: "t1" }, "ch_aizawa_ema"))
    expect(result.current).toEqual({ videoId: "v1", title: "t1" })
  })

  it("is null for a different creator than the one the selection was made for", () => {
    act(() => selectHomeVideo({ videoId: "v1", title: "t1" }, "ch_aizawa_ema"))
    const { result } = renderHook(() => useHomeSelectedVideo("ch_shirakami_fubuki"))
    expect(result.current).toBeNull()
  })

  it("drops a previous creator's selection once read for the newly current creator, without any caller-side reset", () => {
    act(() => selectHomeVideo({ videoId: "v1", title: "t1" }, "ch_aizawa_ema"))
    const { result, rerender } = renderHook(({ creatorId }) => useHomeSelectedVideo(creatorId), {
      initialProps: { creatorId: "ch_aizawa_ema" },
    })
    expect(result.current).toEqual({ videoId: "v1", title: "t1" })

    // currentOshi moves to a different creator -- HomePage re-renders this
    // same hook with the new creatorId, same as it would on a real switch.
    rerender({ creatorId: "ch_shirakami_fubuki" })
    expect(result.current).toBeNull()
  })

  it("a later selectHomeVideo call for a new creator updates every mounted reader immediately", () => {
    const { result } = renderHook(() => useHomeSelectedVideo("ch_shirakami_fubuki"))
    expect(result.current).toBeNull()

    act(() => selectHomeVideo({ videoId: "v2", title: "t2" }, "ch_shirakami_fubuki"))
    expect(result.current).toEqual({ videoId: "v2", title: "t2" })
  })
})
