import { renderHook, act } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useOshiTransform } from "./useOshiTransform"
import { DEFAULT_OSHI_TRANSFORM, readOshiTransform } from "../lib/oshiTransformStore"

describe("useOshiTransform", () => {
  it("starts at the default transform for a creator with nothing saved", () => {
    const { result } = renderHook(() => useOshiTransform("ch_fresh"))
    expect(result.current.transform).toEqual(DEFAULT_OSHI_TRANSFORM)
  })

  it("persists moveTo/setScale to localStorage under that creator's key", () => {
    const { result } = renderHook(() => useOshiTransform("ch_move"))

    act(() => result.current.moveTo(20, 40))
    expect(result.current.transform.x).toBe(20)
    expect(result.current.transform.y).toBe(40)
    expect(readOshiTransform("ch_move").x).toBe(20)

    act(() => result.current.setScale(1.8))
    expect(result.current.transform.scale).toBe(1.8)
    expect(readOshiTransform("ch_move").scale).toBe(1.8)
  })

  it("reloads the other creator's own saved transform when creatorId changes, not the previous one's draft", () => {
    const { result, rerender } = renderHook(({ creatorId }) => useOshiTransform(creatorId), {
      initialProps: { creatorId: "ch_a" },
    })
    act(() => result.current.moveTo(70, 70))

    rerender({ creatorId: "ch_b" })
    expect(result.current.transform).toEqual(DEFAULT_OSHI_TRANSFORM)

    rerender({ creatorId: "ch_a" })
    expect(result.current.transform.x).toBe(70)
  })

  it("reset clears the saved override and returns to the default", () => {
    const { result } = renderHook(() => useOshiTransform("ch_reset"))
    act(() => result.current.moveTo(5, 5))
    act(() => result.current.reset())
    expect(result.current.transform).toEqual(DEFAULT_OSHI_TRANSFORM)
    expect(readOshiTransform("ch_reset")).toEqual(DEFAULT_OSHI_TRANSFORM)
  })
})
