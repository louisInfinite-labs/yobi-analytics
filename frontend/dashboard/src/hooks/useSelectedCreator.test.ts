import { renderHook, act } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useSelectedCreator } from "./useSelectedCreator"
import { mockCreators } from "../data/mockCreators"
import { resetAllSharedStateForTests } from "../lib/sharedState"

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

  it("seeds its initial value from Settings > 我推設定's own persisted default (defaultOshi), on a fresh load", () => {
    window.localStorage.setItem("yobi.defaultOshiCreatorId", "ch_gawr_gura")
    resetAllSharedStateForTests()
    const { result } = renderHook(() => useSelectedCreator())
    expect(result.current[0]).toBe("ch_gawr_gura")
  })

  it("ignores its own previously-persisted selection on a fresh load -- currentOshi is session-only, re-seeded from defaultOshi every time, not resumed from a prior session", () => {
    // Simulates a prior session where the user switched to a creator other
    // than the (default) one -- this hook's own storage key still gets
    // written on switch, but must never be read back as the seed for a new
    // session (see useSelectedCreator.ts's own comment on this).
    window.localStorage.setItem("yobi.home.selectedCreatorId", "ch_usada_pekora")
    resetAllSharedStateForTests()
    const { result } = renderHook(() => useSelectedCreator())
    expect(result.current[0]).toBe(mockCreators[0].channelId)
  })
})
