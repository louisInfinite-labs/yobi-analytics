import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { usePageViewTracking } from "./usePageViewTracking"
import type { Page } from "./useCurrentPage"

const track = vi.hoisted(() => vi.fn())
vi.mock("../../shared/analytics/analytics", () => ({ trackPageView: track }))

beforeEach(() => track.mockReset())

describe("usePageViewTracking", () => {
  it("reports each of the four production pages with its canonical path and title", () => {
    const { rerender } = renderHook(({ page }: { page: Page }) => usePageViewTracking(page, true), { initialProps: { page: "home" as Page } })
    for (const page of ["schedule", "settings", "about", "home"] as Page[]) rerender({ page })

    expect(track.mock.calls).toEqual([
      ["/", "Home"],
      ["/schedule", "Schedule"],
      ["/setting", "Settings"],
      ["/about", "About"],
      ["/", "Home"],
    ])
  })

  it("does not report again on a re-render of the same page", () => {
    const { rerender } = renderHook(({ page }: { page: Page }) => usePageViewTracking(page, true), { initialProps: { page: "schedule" as Page } })
    rerender({ page: "schedule" })
    rerender({ page: "schedule" })

    expect(track).toHaveBeenCalledTimes(1)
  })

  it("never reports the development-only Video Data page, or anything while disabled (the admin tool)", () => {
    renderHook(() => usePageViewTracking("dashboard", true))
    renderHook(() => usePageViewTracking("home", false))

    expect(track).not.toHaveBeenCalled()
  })
})
