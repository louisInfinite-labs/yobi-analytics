import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useOrderedCreatorSelection } from "./useOrderedCreatorSelection"
import { useSelectedCreator } from "../../../oshi/hooks/useSelectedCreator"
import { mockCreators } from "../../../../entities/creator/data/mockCreators"

describe("useOrderedCreatorSelection", () => {
  it("MT-10 AC1: clicking A, then B, then C stores the click order", () => {
    const { result } = renderHook(() => useOrderedCreatorSelection())

    act(() => result.current.toggle("creator-a"))
    act(() => result.current.toggle("creator-b"))
    act(() => result.current.toggle("creator-c"))

    expect(result.current.orderedIds).toEqual(["creator-a", "creator-b", "creator-c"])
    expect(result.current.orderOf("creator-a")).toBe(1)
    expect(result.current.orderOf("creator-b")).toBe(2)
    expect(result.current.orderOf("creator-c")).toBe(3)
  })

  it("MT-10 AC4: deselecting B renumbers A and C consecutively", () => {
    const { result } = renderHook(() => useOrderedCreatorSelection())

    act(() => result.current.toggle("creator-a"))
    act(() => result.current.toggle("creator-b"))
    act(() => result.current.toggle("creator-c"))
    act(() => result.current.toggle("creator-b"))

    expect(result.current.orderedIds).toEqual(["creator-a", "creator-c"])
    expect(result.current.orderOf("creator-a")).toBe(1)
    expect(result.current.orderOf("creator-c")).toBe(2)
    expect(result.current.orderOf("creator-b")).toBeNull()
  })

  it("MT-10 AC5: reselecting B appends it to the end", () => {
    const { result } = renderHook(() => useOrderedCreatorSelection())

    act(() => result.current.toggle("creator-a"))
    act(() => result.current.toggle("creator-b"))
    act(() => result.current.toggle("creator-c"))
    act(() => result.current.toggle("creator-b")) // deselect
    act(() => result.current.toggle("creator-b")) // reselect

    expect(result.current.orderedIds).toEqual(["creator-a", "creator-c", "creator-b"])
    expect(result.current.orderOf("creator-b")).toBe(3)
  })

  it("MT-10 AC7: toggling the same id twice without an intervening deselect never duplicates it", () => {
    // toggle() is select/deselect, so this proves the underlying add path
    // (creatorComparisonOrder.addCreatorToOrder) rather than a second click;
    // see creatorComparisonOrder.test.ts for the direct duplicate-add proof.
    const { result } = renderHook(() => useOrderedCreatorSelection(["creator-a"]))

    expect(result.current.orderedIds).toEqual(["creator-a"])
  })

  it("MT-10 AC8: canCompare is false below two creators and true from two onward", () => {
    const { result } = renderHook(() => useOrderedCreatorSelection())
    expect(result.current.canCompare).toBe(false)

    act(() => result.current.toggle("creator-a"))
    expect(result.current.canCompare).toBe(false)

    act(() => result.current.toggle("creator-b"))
    expect(result.current.canCompare).toBe(true)
  })

  it("seeds from an already-selected widget configuration and deduplicates it", () => {
    const { result } = renderHook(() => useOrderedCreatorSelection(["creator-a", "creator-b", "creator-a"]))

    expect(result.current.orderedIds).toEqual(["creator-a", "creator-b"])
    expect(result.current.orderOf("creator-a")).toBe(1)
    expect(result.current.orderOf("creator-b")).toBe(2)
  })

  it("MT-10 AC10: toggling selection never changes the application's active creator", () => {
    const selection = renderHook(() => useOrderedCreatorSelection())
    const activeCreator = renderHook(() => useSelectedCreator())

    const activeBefore = activeCreator.result.current[0]
    expect(activeBefore).toBe(mockCreators[0].channelId)

    act(() => selection.result.current.toggle("creator-a"))
    act(() => selection.result.current.toggle("creator-b"))
    act(() => selection.result.current.toggle("creator-a")) // deselect

    expect(activeCreator.result.current[0]).toBe(activeBefore)
  })
})
