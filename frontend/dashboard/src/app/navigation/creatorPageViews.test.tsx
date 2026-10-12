/** L. GA4 route tracking, end to end through the real analytics module (only the Firebase SDK is faked): a change of path produces exactly one
 * page_view, and same-route interactions produce none. */
import { renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const firebase = vi.hoisted(() => ({
  initializeApp: vi.fn(),
  getApps: vi.fn(),
  getAnalytics: vi.fn(),
  isSupported: vi.fn(),
  logEvent: vi.fn(),
}))
vi.mock("firebase/app", () => ({ initializeApp: firebase.initializeApp, getApps: firebase.getApps }))
vi.mock("firebase/analytics", () => ({ getAnalytics: firebase.getAnalytics, isSupported: firebase.isSupported, logEvent: firebase.logEvent }))

import { initAnalytics, resetAnalyticsForTests } from "../../shared/analytics/analytics"
import type { Page } from "./useCurrentPage"
import { usePageViewTracking } from "./usePageViewTracking"

interface Props {
  page: Page
  path: string
}

beforeEach(async () => {
  Object.values(firebase).forEach((mock) => mock.mockReset())
  firebase.getApps.mockReturnValue([])
  firebase.initializeApp.mockReturnValue({ name: "[DEFAULT]" })
  firebase.getAnalytics.mockReturnValue({ id: "analytics" })
  firebase.isSupported.mockResolvedValue(true)
  resetAnalyticsForTests()
  vi.stubEnv("PROD", true)
  await initAnalytics("oshiyobi.web.app") // the production site: Analytics is running
})

afterEach(() => {
  vi.unstubAllEnvs()
})

async function settle() {
  await initAnalytics("oshiyobi.web.app")
}

const viewed = () => firebase.logEvent.mock.calls.map(([, name, params]) => [name, params.page_path])

describe("L. creator routes in GA4", () => {
  it("/creator/aizawa-ema -> /creator/kurumi-noa produces exactly one new page_view, for the new path", async () => {
    const { rerender } = renderHook(({ page, path }: Props) => usePageViewTracking(page, path, true), { initialProps: { page: "home", path: "/creator/aizawa-ema" } as Props })
    await settle()
    expect(firebase.logEvent).not.toHaveBeenCalled() // the landing page_view is the SDK's own

    rerender({ page: "home", path: "/creator/kurumi-noa" })
    await settle()

    expect(viewed()).toEqual([["page_view", "/creator/kurumi-noa"]])
    expect(firebase.logEvent.mock.calls[0][2]).toMatchObject({ page_location: `${window.location.origin}/creator/kurumi-noa` })
  })

  it("/schedule -> /creator/aizawa-ema produces exactly one creator-route page_view", async () => {
    const { rerender } = renderHook(({ page, path }: Props) => usePageViewTracking(page, path, true), { initialProps: { page: "schedule", path: "/schedule" } as Props })
    await settle()

    rerender({ page: "home", path: "/creator/aizawa-ema" })
    await settle()

    expect(viewed()).toEqual([["page_view", "/creator/aizawa-ema"]])
  })

  it("same-route interactions (re-renders, selecting the creator already shown) add nothing", async () => {
    const { rerender } = renderHook(({ page, path }: Props) => usePageViewTracking(page, path, true), { initialProps: { page: "home", path: "/creator/aizawa-ema" } as Props })
    rerender({ page: "home", path: "/creator/aizawa-ema" })
    rerender({ page: "home", path: "/creator/aizawa-ema" })
    await settle()

    expect(firebase.logEvent).not.toHaveBeenCalled()
  })

  it("a visit to the root '/' is recorded as '/', and returning to it is one page_view for '/'", async () => {
    const { rerender } = renderHook(({ page, path }: Props) => usePageViewTracking(page, path, true), { initialProps: { page: "home", path: "/" } as Props })
    await settle()
    expect(firebase.logEvent).not.toHaveBeenCalled() // the landing page_view ('/') is the SDK's own

    rerender({ page: "schedule", path: "/schedule" })
    rerender({ page: "home", path: "/" })
    rerender({ page: "home", path: "/creator/kurumi-noa" })
    await settle()

    expect(viewed()).toEqual([
      ["page_view", "/schedule"],
      ["page_view", "/"],
      ["page_view", "/creator/kurumi-noa"],
    ])
  })

  it("a full tour logs one page_view per change of path and nothing else", async () => {
    const { rerender } = renderHook(({ page, path }: Props) => usePageViewTracking(page, path, true), { initialProps: { page: "home", path: "/creator/aizawa-ema" } as Props })
    for (const next of [
      { page: "schedule", path: "/schedule" },
      { page: "home", path: "/creator/kurumi-noa" },
      { page: "home", path: "/creator/kurumi-noa" },
      { page: "about", path: "/about" },
      { page: "home", path: "/creator/aizawa-ema" },
    ] as Props[]) {
      rerender(next)
      await settle()
    }

    expect(viewed()).toEqual([
      ["page_view", "/schedule"],
      ["page_view", "/creator/kurumi-noa"],
      ["page_view", "/about"],
      ["page_view", "/creator/aizawa-ema"],
    ])
  })
})
