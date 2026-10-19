import { renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useResetScrollOnCreatorChange } from "./useResetScrollOnCreatorChange"

/** The hook's logic against a controllable `window.scrollY`; the real scroll container (the document, in real Chromium at phone/tablet/desktop
 * widths) is measured by e2e/home-creator-scroll-reset.spec.ts. */

let scrollY = 0
let frames: Array<() => void> = []
const scrollTo = vi.fn((options: ScrollToOptions) => {
  scrollY = options.top ?? scrollY
})

beforeEach(() => {
  scrollY = 0
  frames = []
  scrollTo.mockClear()
  vi.stubGlobal("scrollTo", scrollTo)
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY })
  Object.defineProperty(window, "scrollX", { configurable: true, get: () => 0 })
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(() => callback(0)))
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function flushFrames() {
  const pending = frames
  frames = []
  pending.forEach((run) => run())
}

describe("useResetScrollOnCreatorChange", () => {
  it("A scrolled down -> B: the page jumps to the very top, immediately and never animated", () => {
    const { rerender } = renderHook(({ creator }) => useResetScrollOnCreatorChange(creator, true), { initialProps: { creator: "A" } })
    scrollY = 900

    rerender({ creator: "B" })

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "instant" })
    expect(scrollY).toBe(0)
  })

  it("B scrolled down -> back to A: every creator change resets (A -> B -> A -> B)", () => {
    const { rerender } = renderHook(({ creator }) => useResetScrollOnCreatorChange(creator, true), { initialProps: { creator: "A" } })
    for (const next of ["B", "A", "B"]) {
      scrollY = 700
      rerender({ creator: next })
      expect(scrollY, next).toBe(0)
    }
    expect(scrollTo).toHaveBeenCalledTimes(3)
  })

  it("applies the reset once more on the next frame, because the browser may restore a history entry's scroll just after a Back/Forward popstate", () => {
    const { rerender } = renderHook(({ creator }) => useResetScrollOnCreatorChange(creator, true), { initialProps: { creator: "A" } })
    scrollY = 900
    rerender({ creator: "B" })
    scrollY = 640 // the browser's own restoration

    flushFrames()

    expect(scrollY).toBe(0)
  })

  it("never resets for the same creator: re-renders (data refreshes, topic/filter/sort/search changes) keep the position", () => {
    const { rerender } = renderHook(({ creator }) => useResetScrollOnCreatorChange(creator, true), { initialProps: { creator: "A" } })
    scrollY = 900

    for (let render = 0; render < 5; render++) rerender({ creator: "A" })
    flushFrames()

    expect(scrollTo).not.toHaveBeenCalled()
    expect(scrollY).toBe(900)
  })

  it("leaves the first render alone (a reload or a page switch -- App.tsx already starts those at the top)", () => {
    scrollY = 900

    renderHook(() => useResetScrollOnCreatorChange("A", true))
    flushFrames()

    expect(scrollTo).not.toHaveBeenCalled()
  })

  it("desktop (disabled): a creator change never touches the scroll position", () => {
    const { rerender } = renderHook(({ creator }) => useResetScrollOnCreatorChange(creator, false), { initialProps: { creator: "A" } })
    scrollY = 900

    rerender({ creator: "B" })
    flushFrames()

    expect(scrollTo).not.toHaveBeenCalled()
    expect(scrollY).toBe(900)
  })

  it("a resize across the breakpoint is not a creator change: no reset, and the creator change that follows it does reset", () => {
    const { rerender } = renderHook(({ creator, enabled }) => useResetScrollOnCreatorChange(creator, enabled), { initialProps: { creator: "A", enabled: false } })
    scrollY = 900

    rerender({ creator: "A", enabled: true })
    expect(scrollTo).not.toHaveBeenCalled()

    rerender({ creator: "B", enabled: true })
    expect(scrollY).toBe(0)
  })

  it("does nothing when the page is already at the top (no needless scroll call)", () => {
    const { rerender } = renderHook(({ creator }) => useResetScrollOnCreatorChange(creator, true), { initialProps: { creator: "A" } })

    rerender({ creator: "B" })
    flushFrames()

    expect(scrollTo).not.toHaveBeenCalled()
  })
})
