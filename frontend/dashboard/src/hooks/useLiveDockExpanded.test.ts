import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { resetLiveDockExpandedForTests, setLiveDockExpanded, useLiveDockExpanded } from "./useLiveDockExpanded"

describe("useLiveDockExpanded", () => {
  it("starts false", () => {
    const { result } = renderHook(() => useLiveDockExpanded())
    expect(result.current).toBe(false)
  })

  it("updates every mounted subscriber immediately when setLiveDockExpanded is called", () => {
    const a = renderHook(() => useLiveDockExpanded())
    const b = renderHook(() => useLiveDockExpanded())

    act(() => setLiveDockExpanded(true))

    expect(a.result.current).toBe(true)
    expect(b.result.current).toBe(true)

    act(() => setLiveDockExpanded(false))
    expect(a.result.current).toBe(false)
    expect(b.result.current).toBe(false)
  })

  it("resetLiveDockExpandedForTests restores the false default", () => {
    setLiveDockExpanded(true)
    resetLiveDockExpandedForTests()
    const { result } = renderHook(() => useLiveDockExpanded())
    expect(result.current).toBe(false)
  })
})
