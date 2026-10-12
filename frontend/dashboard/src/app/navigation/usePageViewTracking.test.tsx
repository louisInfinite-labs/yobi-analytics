import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { usePageViewTracking } from "./usePageViewTracking"
import type { Page } from "./useCurrentPage"

const track = vi.hoisted(() => vi.fn())
vi.mock("../../shared/analytics/analytics", () => ({ trackPageView: track }))

beforeEach(() => track.mockReset())

interface Props {
  page: Page
  path: string
}
const render = (initial: Props, enabled = true) => renderHook(({ page, path }: Props) => usePageViewTracking(page, path, enabled), { initialProps: initial })

describe("usePageViewTracking", () => {
  it("reports each fixed page and each creator's Home under its own path, with a readable title", () => {
    const { rerender } = render({ page: "home", path: "/creator/aizawa-ema" })
    rerender({ page: "schedule", path: "/schedule" })
    rerender({ page: "settings", path: "/setting" })
    rerender({ page: "about", path: "/about" })
    rerender({ page: "home", path: "/creator/kurumi-noa" })

    expect(track.mock.calls.map(([path]) => path)).toEqual(["/creator/aizawa-ema", "/schedule", "/setting", "/about", "/creator/kurumi-noa"])
    expect(track.mock.calls[1][1]).toBe("Schedule")
    expect(track.mock.calls[0][1]).toBeTruthy() // the creator's display name
  })

  it("switching creator while staying on Home is a new path, so it is reported (page does not change)", () => {
    const { rerender } = render({ page: "home", path: "/creator/aizawa-ema" })
    rerender({ page: "home", path: "/creator/kurumi-noa" })
    rerender({ page: "home", path: "/creator/aizawa-ema" })

    expect(track.mock.calls.map(([path]) => path)).toEqual(["/creator/aizawa-ema", "/creator/kurumi-noa", "/creator/aizawa-ema"])
  })

  it("does not report again on a re-render with the same page and path", () => {
    const { rerender } = render({ page: "schedule", path: "/schedule" })
    rerender({ page: "schedule", path: "/schedule" })
    rerender({ page: "schedule", path: "/schedule" })

    expect(track).toHaveBeenCalledTimes(1)
  })

  it("the root Home is reported as '/' (whichever creator it shows), and a creator Home under its own path", () => {
    const { rerender } = render({ page: "home", path: "/" })
    rerender({ page: "schedule", path: "/schedule" })
    rerender({ page: "home", path: "/" })
    rerender({ page: "home", path: "/creator/aizawa-ema" })

    expect(track.mock.calls.map(([path]) => path)).toEqual(["/", "/schedule", "/", "/creator/aizawa-ema"])
    expect(track.mock.calls[0][1]).toBe("Home")
  })

  it("never reports an invalid creator path, an unknown path that falls back to Home, the development-only Video Data page, or anything while disabled (the admin tool)", () => {
    render({ page: "home", path: "/creator/not-a-real-creator" })
    render({ page: "home", path: "/some/unknown/page" })
    render({ page: "dashboard", path: "/dashboard" })
    render({ page: "home", path: "/creator/aizawa-ema" }, false)

    expect(track).not.toHaveBeenCalled()
  })
})
