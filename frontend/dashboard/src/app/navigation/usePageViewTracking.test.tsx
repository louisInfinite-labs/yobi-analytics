import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { usePageViewTracking } from "./usePageViewTracking"
import type { Page } from "./useCurrentPage"

const track = vi.hoisted(() => vi.fn())
vi.mock("../../shared/analytics/analytics", () => ({ trackRoute: track }))

beforeEach(() => track.mockReset())

interface Props {
  page: Page
  path: string
}
const render = (initial: Props, enabled = true) => renderHook(({ page, path }: Props) => usePageViewTracking(page, path, enabled), { initialProps: initial })
const paths = () => track.mock.calls.map(([path]) => path)

describe("usePageViewTracking reports every route change (what is measured is decided in analytics.ts)", () => {
  it("reports the root Home as '/', a creator Home under /creator/:slug, and the fixed pages under their own path", () => {
    const { rerender } = render({ page: "home", path: "/" })
    rerender({ page: "schedule", path: "/schedule" })
    rerender({ page: "home", path: "/creator/aizawa-ema" })
    rerender({ page: "settings", path: "/setting" })
    rerender({ page: "about", path: "/about" })
    rerender({ page: "home", path: "/" })

    expect(paths()).toEqual(["/", "/schedule", "/creator/aizawa-ema", "/setting", "/about", "/"])
    expect(track.mock.calls[0][1]).toBe("Home")
    expect(track.mock.calls[1][1]).toBe("Schedule")
    expect(track.mock.calls[2][1]).toBeTruthy() // the creator's display name
  })

  it("switching creator while staying on Home is a new path, so it is reported (page does not change)", () => {
    const { rerender } = render({ page: "home", path: "/creator/aizawa-ema" })
    rerender({ page: "home", path: "/creator/kurumi-noa" })
    rerender({ page: "home", path: "/creator/aizawa-ema" })

    expect(paths()).toEqual(["/creator/aizawa-ema", "/creator/kurumi-noa", "/creator/aizawa-ema"])
  })

  it("does not report again on a re-render with the same page and path", () => {
    const { rerender } = render({ page: "schedule", path: "/schedule" })
    rerender({ page: "schedule", path: "/schedule" })
    rerender({ page: "schedule", path: "/schedule" })

    expect(track).toHaveBeenCalledTimes(1)
  })

  it("canonicalises a creator path, and passes an unknown or invalid Home path through as it is (analytics.ts then does not measure it)", () => {
    render({ page: "home", path: "/creator/aizawa-ema/" })
    render({ page: "home", path: "/some/unknown/page" })

    expect(paths()).toEqual(["/creator/aizawa-ema", "/some/unknown/page"])
  })

  it("reports nothing for the development-only Video Data page, or anything while disabled (the admin tool)", () => {
    render({ page: "dashboard", path: "/dashboard" })
    render({ page: "home", path: "/creator/aizawa-ema" }, false)

    expect(track).not.toHaveBeenCalled()
  })
})
