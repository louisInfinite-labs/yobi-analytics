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

import { firebaseConfig } from "./firebaseConfig"
import { initAnalytics, isAnalyticsEnvironment, resetAnalyticsForTests, trackPageView } from "./analytics"

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
    trackPageView("/", "Home")
    trackPageView("/schedule", "Schedule")
    trackPageView("/about", "About")
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
  beforeEach(() => vi.stubEnv("PROD", true))

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

  it("logs one page_view per page CHANGE: the landing page is the SDK's own, repeats are ignored", async () => {
    await initAnalytics(PRODUCTION_HOST)

    trackPageView("/", "Home") // the page the visitor landed on: the SDK already sends this page_view
    await initAnalytics(PRODUCTION_HOST)
    expect(firebase.logEvent).not.toHaveBeenCalled()

    trackPageView("/schedule", "Schedule")
    trackPageView("/schedule", "Schedule") // the same page again: never twice
    await initAnalytics(PRODUCTION_HOST)
    trackPageView("/about", "About")
    trackPageView("/", "Home")
    await initAnalytics(PRODUCTION_HOST)

    const views = firebase.logEvent.mock.calls.map(([, name, params]) => [name, params.page_path, params.page_title])
    expect(views).toEqual([
      ["page_view", "/schedule", "Schedule"],
      ["page_view", "/about", "About"],
      ["page_view", "/", "Home"],
    ])
    expect(firebase.logEvent.mock.calls[0][2]).toEqual({ page_path: "/schedule", page_title: "Schedule", page_location: `${window.location.origin}/schedule` })
  })

  it("logs nothing if Analytics could not start", async () => {
    firebase.isSupported.mockResolvedValue(false)
    await initAnalytics(PRODUCTION_HOST)

    trackPageView("/", "Home")
    trackPageView("/schedule", "Schedule")
    await initAnalytics(PRODUCTION_HOST)

    expect(firebase.logEvent).not.toHaveBeenCalled()
  })
})
