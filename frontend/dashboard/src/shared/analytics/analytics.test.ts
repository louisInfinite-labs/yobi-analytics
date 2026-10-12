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
vi.mock("firebase/analytics", () => ({ getAnalytics: firebase.getAnalytics, isSupported: firebase.isSupported, logEvent: firebase.logEvent, setAnalyticsCollectionEnabled: firebase.setAnalyticsCollectionEnabled }))

import { firebaseConfig } from "./firebaseConfig"
import { initAnalytics, isAnalyticsEnvironment, isAnalyticsRoute, resetAnalyticsForTests, trackRoute } from "./analytics"

const PRODUCTION_HOST = "oshiyobi.web.app"

beforeEach(() => {
  Object.values(firebase).forEach((mock) => mock.mockReset())
  firebase.getApps.mockReturnValue([])
  firebase.initializeApp.mockReturnValue({ name: "[DEFAULT]" })
  firebase.getAnalytics.mockReturnValue({ id: "analytics" })
  firebase.isSupported.mockResolvedValue(true)
  resetAnalyticsForTests()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("which pages are measured", () => {
  it("only a production build served from the deployed hosting domains", () => {
    vi.stubEnv("PROD", true)
    expect(isAnalyticsEnvironment("oshiyobi.web.app")).toBe(true)
    expect(isAnalyticsEnvironment("oshiyobi.firebaseapp.com")).toBe(true)
    for (const other of ["localhost", "127.0.0.1", "preview.example.com", "oshiyobi.web.app.evil.test"]) expect(isAnalyticsEnvironment(other)).toBe(false)
  })

  it("never in a development/test build, even on the production hostname", () => {
    vi.stubEnv("PROD", false)
    expect(isAnalyticsEnvironment("oshiyobi.web.app")).toBe(false)
  })
})

describe("under test / on localhost nothing is ever sent", () => {
  it("does not load Firebase, create an app, load gtag.js or call fetch/beacon, however much the app tracks", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const beacon = vi.fn()
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true })

    await expect(initAnalytics()).resolves.toBeNull()
    trackRoute("/", "Home")
    trackRoute("/schedule", "Schedule")
    trackRoute("/about", "About")
    await initAnalytics()

    expect(firebase.initializeApp).not.toHaveBeenCalled()
    expect(firebase.getAnalytics).not.toHaveBeenCalled()
    expect(firebase.logEvent).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(beacon).not.toHaveBeenCalled()
    expect(document.querySelector('script[src*="googletagmanager"]')).toBeNull()
    fetchSpy.mockRestore()
  })
})

describe("on the production site", () => {
  beforeEach(() => {
    vi.stubEnv("PROD", true)
    resetAnalyticsForTests(PRODUCTION_HOST) // the page is served from the production site
  })

  it("initialises Firebase with the OshiYobi web config and Analytics exactly once, however often it is called", async () => {
    const [first, second, third] = await Promise.all([initAnalytics(PRODUCTION_HOST), initAnalytics(PRODUCTION_HOST), initAnalytics(PRODUCTION_HOST)])

    expect(first).not.toBeNull()
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(firebase.initializeApp).toHaveBeenCalledTimes(1)
    expect(firebase.initializeApp).toHaveBeenCalledWith(firebaseConfig)
    expect(firebase.getAnalytics).toHaveBeenCalledTimes(1)
    expect(firebaseConfig.measurementId).toMatch(/^G-[A-Z0-9]+$/)
    expect(firebaseConfig.projectId).toBe("oshiyobi")
  })

  it("reuses a Firebase app that already exists instead of initialising a second one", async () => {
    const existing = { name: "[DEFAULT]" }
    firebase.getApps.mockReturnValue([existing])

    await initAnalytics(PRODUCTION_HOST)

    expect(firebase.initializeApp).not.toHaveBeenCalled()
    expect(firebase.getAnalytics).toHaveBeenCalledWith(existing)
  })

  it("does nothing in a browser that does not support Analytics", async () => {
    firebase.isSupported.mockResolvedValue(false)

    await expect(initAnalytics(PRODUCTION_HOST)).resolves.toBeNull()
    expect(firebase.getAnalytics).not.toHaveBeenCalled()
  })

  it("never lets an Analytics failure escape (blocked script, init error)", async () => {
    firebase.getAnalytics.mockImplementation(() => {
      throw new Error("blocked")
    })

    await expect(initAnalytics(PRODUCTION_HOST)).resolves.toBeNull()
  })

  it("the first measured route starts Analytics (the SDK's own page_view covers it); each later change of path logs exactly one page_view", async () => {
    trackRoute("/", "Home")
    await initAnalytics(PRODUCTION_HOST)
    expect(firebase.getAnalytics).toHaveBeenCalledTimes(1)
    expect(firebase.logEvent).not.toHaveBeenCalled()

    trackRoute("/schedule", "Schedule")
    trackRoute("/schedule", "Schedule") // the same path again: never twice
    await initAnalytics(PRODUCTION_HOST)
    trackRoute("/creator/aizawa-ema", "Ema")
    trackRoute("/", "Home")
    await initAnalytics(PRODUCTION_HOST)

    expect(firebase.logEvent.mock.calls.map(([, name, params]) => [name, params.page_path, params.page_title])).toEqual([
      ["page_view", "/schedule", "Schedule"],
      ["page_view", "/creator/aizawa-ema", "Ema"],
      ["page_view", "/", "Home"],
    ])
    expect(firebase.logEvent.mock.calls[0][2]).toEqual({ page_path: "/schedule", page_title: "Schedule", page_location: `${window.location.origin}/schedule` })
  })

  it("a visit that lands on an unmeasured route sends nothing and does not even start Analytics", async () => {
    trackRoute("/about", "About")
    trackRoute("/setting", "Settings")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(firebase.initializeApp).not.toHaveBeenCalled()
    expect(firebase.getAnalytics).not.toHaveBeenCalled()
    expect(firebase.logEvent).not.toHaveBeenCalled()
    expect(firebase.setAnalyticsCollectionEnabled).not.toHaveBeenCalled()
  })

  it("landing on About then opening Schedule starts Analytics there (its own page_view covers Schedule), then leaving it switches collection off", async () => {
    trackRoute("/about", "About")
    trackRoute("/schedule", "Schedule")
    await initAnalytics(PRODUCTION_HOST)
    expect(firebase.getAnalytics).toHaveBeenCalledTimes(1)
    expect(firebase.logEvent).not.toHaveBeenCalled()

    trackRoute("/setting", "Settings")
    await initAnalytics(PRODUCTION_HOST)
    expect(firebase.setAnalyticsCollectionEnabled).toHaveBeenLastCalledWith({ id: "analytics" }, false)
    expect(firebase.logEvent).not.toHaveBeenCalled()
  })

  it("leaving a measured route for an unmeasured one pauses collection, and coming back resumes it before logging the page_view", async () => {
    trackRoute("/creator/aizawa-ema", "Ema")
    await initAnalytics(PRODUCTION_HOST)
    trackRoute("/about", "About")
    await initAnalytics(PRODUCTION_HOST)
    trackRoute("/schedule", "Schedule")
    await initAnalytics(PRODUCTION_HOST)

    const order = [...firebase.setAnalyticsCollectionEnabled.mock.invocationCallOrder, ...firebase.logEvent.mock.invocationCallOrder]
    expect(firebase.setAnalyticsCollectionEnabled.mock.calls.map(([, on]) => on)).toEqual([false, true])
    expect(firebase.logEvent.mock.calls.map(([, , params]) => params.page_path)).toEqual(["/schedule"]) // nothing was logged for /about
    expect(Math.max(...firebase.setAnalyticsCollectionEnabled.mock.invocationCallOrder)).toBeLessThan(Math.min(...firebase.logEvent.mock.invocationCallOrder))
    expect(order.length).toBe(3)
  })

  it("logs nothing if Analytics could not start", async () => {
    firebase.isSupported.mockResolvedValue(false)
    trackRoute("/", "Home")
    trackRoute("/schedule", "Schedule")
    await initAnalytics(PRODUCTION_HOST)

    expect(firebase.logEvent).not.toHaveBeenCalled()
    expect(firebase.setAnalyticsCollectionEnabled).not.toHaveBeenCalled()
  })
})

describe("which routes are measured: only /, /creator, /creator/* and /schedule", () => {
  it("measures them", () => {
    for (const path of ["/", "/schedule", "/schedule/", "/creator", "/creator/", "/creator/tachibana-hinano", "/creator/aizawa-ema"]) {
      expect(isAnalyticsRoute(path), path).toBe(true)
    }
  })

  it("never measures any other route", () => {
    for (const path of ["/setting", "/about", "/dashboard", "/creators", "/creatorx", "/schedule/extra", "/some/unknown/page", "/admin"]) {
      expect(isAnalyticsRoute(path), path).toBe(false)
    }
  })
})
