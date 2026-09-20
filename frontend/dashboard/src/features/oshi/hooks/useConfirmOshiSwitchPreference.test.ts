import { renderHook, act } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useConfirmOshiSwitchPreference } from "./useConfirmOshiSwitchPreference"

describe("useConfirmOshiSwitchPreference", () => {
  it("defaults to true", () => {
    const { result } = renderHook(() => useConfirmOshiSwitchPreference())
    expect(result.current[0]).toBe(true)
  })

  it("setting it to false then true round-trips", () => {
    const { result } = renderHook(() => useConfirmOshiSwitchPreference())
    act(() => result.current[1](false))
    expect(result.current[0]).toBe(false)
    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
  })

  it("persists across hook instances", () => {
    const first = renderHook(() => useConfirmOshiSwitchPreference())
    act(() => first.result.current[1](false))

    const second = renderHook(() => useConfirmOshiSwitchPreference())
    expect(second.result.current[0]).toBe(false)
  })

  it("updates an already-mounted consumer immediately when another mounted consumer sets it — no remount required", () => {
    // Simulates checking "Don't ask again" + Switch in one mounted
    // Oshi-switch entry point (e.g. the Dock) needing every OTHER
    // already-mounted one (e.g. Home's panel) to stop showing the
    // confirmation dialog right away, not only after a remount.
    const dock = renderHook(() => useConfirmOshiSwitchPreference())
    const home = renderHook(() => useConfirmOshiSwitchPreference())

    act(() => {
      dock.result.current[1](false)
    })

    expect(dock.result.current[0]).toBe(false)
    expect(home.result.current[0]).toBe(false)
  })
})
