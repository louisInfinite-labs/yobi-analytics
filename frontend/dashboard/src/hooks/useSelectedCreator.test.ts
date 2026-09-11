import { renderHook, act } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useSelectedCreator } from "./useSelectedCreator"
import { mockCreators } from "../data/mockCreators"

describe("useSelectedCreator", () => {
  it("defaults to the first known creator", () => {
    const { result } = renderHook(() => useSelectedCreator())
    expect(result.current[0]).toBe(mockCreators[0].channelId)
  })

  it("persists across hook instances mounted after the change", () => {
    const first = renderHook(() => useSelectedCreator())
    act(() => first.result.current[1]("ch_gawr_gura"))

    const second = renderHook(() => useSelectedCreator())
    expect(second.result.current[0]).toBe("ch_gawr_gura")
  })

  it("updates an already-mounted consumer immediately when another mounted consumer switches Oshi — no remount required", () => {
    // Simulates LiveScheduleDock and HomePage both mounted at once: switching
    // Oshi from one must be reflected by the other right away (this task's
    // "SELECTED OSHI MUST SYNC IMMEDIATELY" requirement), not only the next
    // time it happens to re-read localStorage.
    const dock = renderHook(() => useSelectedCreator())
    const home = renderHook(() => useSelectedCreator())

    act(() => {
      dock.result.current[1]("ch_gawr_gura")
    })

    expect(dock.result.current[0]).toBe("ch_gawr_gura")
    expect(home.result.current[0]).toBe("ch_gawr_gura")
  })
})
