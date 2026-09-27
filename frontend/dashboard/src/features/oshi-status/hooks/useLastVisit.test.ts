import { renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { resetPreviousVisit, usePreviousVisit } from "./useLastVisit"

describe("resetPreviousVisit", () => {
  it("is a DEV-only no-op-safe rewind that updates every mounted usePreviousVisit without a reload", () => {
    const { result, rerender } = renderHook(() => usePreviousVisit())
    const before = result.current

    resetPreviousVisit()
    rerender()

    expect(result.current).not.toBe(before)
    expect(result.current).toBeInstanceOf(Date)
    // Rewound into the past (not into the future/now), so the mock unseen
    // entries -- a few minutes old -- register as unseen again.
    expect((result.current as Date).getTime()).toBeLessThan(Date.now())
  })

  it("persists the rewound value under the same existing storage key, not a new one", () => {
    resetPreviousVisit()
    expect(window.localStorage.getItem("yobi.home.lastVisitAt")).not.toBeNull()
  })
})
