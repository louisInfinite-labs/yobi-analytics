import { renderHook, act } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useFavoriteCreators } from "./useFavoriteCreators"

describe("useFavoriteCreators", () => {
  it("starts with no favorites", () => {
    const { result } = renderHook(() => useFavoriteCreators())
    expect(result.current.favorites.size).toBe(0)
  })

  it("toggling a creator on then off returns to not-favorited", () => {
    const { result } = renderHook(() => useFavoriteCreators())
    act(() => result.current.toggleFavorite("ch_a"))
    expect(result.current.favorites.has("ch_a")).toBe(true)
    act(() => result.current.toggleFavorite("ch_a"))
    expect(result.current.favorites.has("ch_a")).toBe(false)
  })

  it("persists across hook instances", () => {
    const first = renderHook(() => useFavoriteCreators())
    act(() => first.result.current.toggleFavorite("ch_b"))

    const second = renderHook(() => useFavoriteCreators())
    expect(second.result.current.favorites.has("ch_b")).toBe(true)
  })

  it("keeps multiple favorites independent", () => {
    const { result } = renderHook(() => useFavoriteCreators())
    act(() => result.current.toggleFavorite("ch_a"))
    act(() => result.current.toggleFavorite("ch_b"))
    expect([...result.current.favorites].sort()).toEqual(["ch_a", "ch_b"])
  })

  it("updates an already-mounted consumer immediately when another mounted consumer toggles a favorite — no remount required", () => {
    // Simulates a swipe-favorite gesture in one mounted CreatorStatusList
    // (Task 2) needing the avatar heart / favorites view / live-offline
    // counts in every OTHER already-mounted CreatorStatusList to update
    // right away, not only the next time one happens to remount.
    const dock = renderHook(() => useFavoriteCreators())
    const home = renderHook(() => useFavoriteCreators())

    act(() => {
      dock.result.current.toggleFavorite("ch_aizawa_ema")
    })

    expect(dock.result.current.favorites.has("ch_aizawa_ema")).toBe(true)
    expect(home.result.current.favorites.has("ch_aizawa_ema")).toBe(true)
  })
})
