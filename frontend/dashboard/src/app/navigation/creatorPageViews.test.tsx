/** GA4 route tracking end to end through the real analytics module (only the Firebase SDK is faked): a change of path produces exactly one
 * page_view, same-route interactions produce none, and only "/", "/creator/*" and "/schedule" are ever measured. */
import { renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const firebase = vi.hoisted(() => ({
  initializeApp: vi.fn(),
  getApps: vi.fn(),
  getAnalytics: vi.fn(),
  isSupported: vi.fn(),
  logEvent: vi.fn(),
  setAnalyticsCollectionEnabled: vi.fn(),
}))
vi.mock("firebase/app", () => ({ initializeApp: firebase.initializeApp, getApps: firebase.getApps }))
vi.mock("firebase/analytics", () => ({
  getAnalytics: firebase.getAnalytics,
  isSupported: firebase.isSupported,
  logEvent: firebase.logEvent,
  setAnalyticsCollectionEnabled: firebase.setAnalyticsCollectionEnabled,
}))

import { initAnalytics, resetAnalyticsForTests } from "../../shared/analytics/analytics"
import type { Page } from "./useCurrentPage"
import { usePageViewTracking } from "./usePageViewTracking"

interface Props {
  page: Page
  path: string
}

beforeEach(() => {
  Object.values(firebase).forEach((mock) => mock.mockReset())
  firebase.getApps.mockReturnValue([])
  firebase.initializeApp.mockReturnValue({ name: "[DEFAULT]" })
  firebase.getAnalytics.mockReturnValue({ id: "analytics" })
  firebase.isSupported.mockResolvedValue(true)
  vi.stubEnv("PROD", true)
  resetAnalyticsForTests("oshiyobi.web.app") // the production site
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const settle = () => initAnalytics()
const viewed = () => firebase.logEvent.mock.calls.map(([, name, params]) => [name, params.page_path])
const mount = (initialProps: Props) => renderHook(({ page, path }: Props) => usePageViewTracking(page, path, true), { initialProps })

describe("L. creator routes in GA4", () => {
  it("/creator/aizawa-ema -> /creator/kurumi-noa produces exactly one new page_view, for the new path", async () => {
    const { rerender } = mount({ page: "home", path: "/creator/aizawa-ema" })
    await settle()
    expect(firebase.logEvent).not.toHaveBeenCalled() // the landing page_view is the SDK's own

    rerender({ page: "home", path: "/creator/kurumi-noa" })
    await settle()

    expect(viewed()).toEqual([["page_view", "/creator/kurumi-noa"]])
    expect(firebase.logEvent.mock.calls[0][2]).toMatchObject({ page_location: `${window.location.origin}/creator/kurumi-noa` })
  })

  it("/schedule -> /creator/aizawa-ema produces exactly one creator-route page_view", async () => {
    const { rerender } = mount({ page: "schedule", path: "/schedule" })
    await settle()

    rerender({ page: "home", path: "/creator/aizawa-ema" })
    await settle()

    expect(viewed()).toEqual([["page_view", "/creator/aizawa-ema"]])
  })

  it("a visit to the root '/' is recorded as '/', and returning to it is one page_view for '/'", async () => {
    const { rerender } = mount({ page: "home", path: "/" })
    await settle()
    expect(firebase.logEvent).not.toHaveBeenCalled()

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

  it("same-route interactions (re-renders, selecting the creator already shown) add nothing", async () => {
    const { rerender } = mount({ page: "home", path: "/creator/aizawa-ema" })
    rerender({ page: "home", path: "/creator/aizawa-ema" })
    rerender({ page: "home", path: "/creator/aizawa-ema" })
    await settle()

    expect(firebase.logEvent).not.toHaveBeenCalled()
  })
})

describe("scope: only /, /creator/* and /schedule are measured", () => {
  it("Settings and About produce no page_view, and collection is switched off while the visitor is there", async () => {
    const { rerender } = mount({ page: "schedule", path: "/schedule" })
    await settle()

    rerender({ page: "settings", path: "/setting" })
    rerender({ page: "about", path: "/about" })
    await settle()

    expect(firebase.logEvent).not.toHaveBeenCalled()
    expect(firebase.setAnalyticsCollectionEnabled).toHaveBeenCalledWith({ id: "analytics" }, false)
  })

  it("a visit that only ever sees Settings and About never starts Analytics at all", async () => {
    const { rerender } = mount({ page: "settings", path: "/setting" })
    rerender({ page: "about", path: "/about" })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(firebase.initializeApp).not.toHaveBeenCalled()
    expect(firebase.getAnalytics).not.toHaveBeenCalled()
    expect(firebase.logEvent).not.toHaveBeenCalled()
  })

  it("an unknown path that falls back to Home is not measured", async () => {
    const { rerender } = mount({ page: "schedule", path: "/schedule" })
    await settle()
    rerender({ page: "home", path: "/some/unknown/page" })
    await settle()

    expect(firebase.logEvent).not.toHaveBeenCalled()
  })

  it("a full tour logs one page_view per change into a measured path and nothing for the others", async () => {
    const { rerender } = mount({ page: "home", path: "/creator/aizawa-ema" })
    for (const next of [
      { page: "schedule", path: "/schedule" },
      { page: "settings", path: "/setting" },
      { page: "home", path: "/creator/kurumi-noa" },
      { page: "home", path: "/creator/kurumi-noa" },
      { page: "about", path: "/about" },
      { page: "home", path: "/" },
      { page: "home", path: "/creator/aizawa-ema" },
    ] as Props[]) {
      rerender(next)
      await settle()
    }

    expect(viewed()).toEqual([
      ["page_view", "/schedule"],
      ["page_view", "/creator/kurumi-noa"],
      ["page_view", "/"],
      ["page_view", "/creator/aizawa-ema"],
    ])
  })
})
