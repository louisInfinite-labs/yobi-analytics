import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PushPermissionHost } from "../components/PushPermissionHost"
import { PushPermissionNotice } from "../components/PushPermissionNotice"
import { ensurePushEnabled, resetPushGateForTests } from "./pushGate"
import { checkPushHealth } from "./pushHealth"
import { resetPushStateForTests } from "./pushState"
import { installFakePushDevice } from "../../../test/fakePushDevice"
import { installFakePushBackend, type FakePushBackend } from "../../../test/fakePushBackend"
import * as apiClient from "../../../shared/api/apiClient"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

vi.mock("../../../shared/api/apiClient", () => ({ apiRequest: vi.fn() }))

const IOS = "https://web.push.apple.com/QGZxLjk2"
const IOS_RENEWED = "https://web.push.apple.com/NEW-9f3a"
const ANDROID = "https://fcm.googleapis.com/fcm/send/abc"
const ANDROID_RENEWED = "https://fcm.googleapis.com/fcm/send/xyz"

let fake: ReturnType<typeof installFakePushDevice> | undefined
let backend: FakePushBackend

beforeEach(() => {
  // The test env loads .env.local (the REAL API base URL); with no base URL a request that bypassed the apiClient mock would throw instead of reaching production.
  vi.stubEnv("VITE_API_BASE_URL", "")
  resetPushGateForTests()
  resetPushStateForTests()
  window.localStorage.clear()
  window.localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
  backend = installFakePushBackend(vi.mocked(apiClient.apiRequest))
})
afterEach(() => {
  vi.unstubAllEnvs()
  fake?.restore()
  fake = undefined
  Reflect.deleteProperty(navigator, "standalone")
  vi.unstubAllGlobals()
})

function device(options: Parameters<typeof installFakePushDevice>[0]) {
  fake = installFakePushDevice(options)
  return fake
}
/** An iPhone Home Screen app (navigator.standalone === true) or an installed Android PWA (display-mode: standalone). */
function installedAs(platform: "iphone" | "android") {
  if (platform === "iphone") Object.defineProperty(navigator, "standalone", { value: true, configurable: true })
  else vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("standalone"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }))
}
const writes = () => backend.calls.filter((call) => call.startsWith("PUT") || call.startsWith("DELETE"))
const wrote = (fragment: string) => backend.calls.some((call) => (call.startsWith("PUT") || call.startsWith("DELETE")) && call.includes(fragment))

// ============ 1. permission: never granted / denied / restored (iPhone installed PWA, Android installed PWA and Chrome tab) ============

describe("permission", () => {
  it.each([["iphone", IOS], ["android", ANDROID]] as const)("%s, never asked: explanation, then the prompt, then READY only after the backend confirms the subscription", async (platform, endpoint) => {
    installedAs(platform)
    const push = device({ permission: "default", endpoint })
    const user = userEvent.setup()
    render(<PushPermissionHost />)

    let result: string | undefined
    act(() => void ensurePushEnabled().then((value) => (result = value)))
    await user.click(await screen.findByRole("button", { name: "Continue" }))

    await waitFor(() => expect(result).toBe("ready"))
    expect(push.requestPermission).toHaveBeenCalledTimes(1)
    expect(backend.stored?.endpoint).toBe(endpoint)
    // The order that matters: write the subscription, write the preference, READ the stored subscription back -- only then "ready".
    const calls = backend.calls.filter((call) => /push-subscription|notification-preference|remote-config/.test(call))
    expect(calls[calls.length - 1]).toMatch(/^GET \/remote-config/)
    expect(calls.findIndex((c) => c.startsWith("PUT") && c.includes("push-subscription"))).toBeLessThan(calls.length - 1)
  })

  it.each([
    ["iphone", /Settings → Notifications → OshiYobi/],
    ["android", /Settings → Apps → OshiYobi → Notifications/],
  ] as const)("%s installed app, permission denied: the settings help for THAT platform, nothing enabled, nothing written", async (platform, helpText) => {
    installedAs(platform)
    const push = device({ permission: "denied", endpoint: platform === "iphone" ? IOS : ANDROID })
    const user = userEvent.setup()
    render(<PushPermissionHost />)

    await expect(ensurePushEnabled()).resolves.toBe("denied")
    await user.click(await screen.findByRole("button", { name: "See how" }))

    expect(screen.getByText(helpText)).toBeInTheDocument()
    expect(push.requestPermission).not.toHaveBeenCalled()
    expect(push.subscribe).not.toHaveBeenCalled()
    expect(writes()).toEqual([])
  })

  it("Android Chrome in a normal tab, permission denied: the site-settings help, never a fake 'open settings' link", async () => {
    device({ permission: "denied", endpoint: ANDROID })
    const user = userEvent.setup()
    render(<PushPermissionHost />)

    await expect(ensurePushEnabled()).resolves.toBe("denied")
    await user.click(await screen.findByRole("button", { name: "See how" }))

    expect(screen.getByText(/site settings icon/)).toBeInTheDocument()
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
  })

  it.each([["iphone", IOS], ["android", ANDROID]] as const)("%s: OFF in the system settings, back in the app, ON again -- the help closes by itself and ON is confirmed only after the registration is verified", async (platform, endpoint) => {
    installedAs(platform)
    // The device WAS healthy: subscribed, and the backend holds the subscription.
    const push = device({ permission: "granted", subscribed: true, endpoint })
    backend.stored = { endpoint }
    render(<PushPermissionHost />)
    // 1. the user switches notifications off in the phone's settings; the platform reports denied and (iOS) drops the subscription
    push.device.permission = "denied"
    push.device.subscription = null
    await expect(ensurePushEnabled()).resolves.toBe("denied")
    expect(await screen.findByRole("dialog", { name: "Notification permission is off" })).toBeInTheDocument()
    expect(writes()).toEqual([]) // nothing is enabled, nothing is written, nothing claims ON

    // 2. the user allows notifications in the phone's settings and returns to OshiYobi: no reload, the help disappears
    push.device.permission = "granted"
    act(() => void window.dispatchEvent(new Event("focus")))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())

    // 3. they switch the notification OFF -> ON again: a subscription is created and registered, and ON only after the backend confirms it
    await expect(ensurePushEnabled()).resolves.toBe("ready")
    expect(push.subscribe).toHaveBeenCalledTimes(1)
    expect(push.requestPermission).not.toHaveBeenCalled() // permission is already granted: no prompt
    expect(wrote("push-subscription") && backend.stored?.endpoint === endpoint && !backend.inactive).toBe(true)
  })

  it("a platform that does not report the system switch (permission still 'granted' although notifications are off in the OS) cannot be detected here -- the repair notice carries the guidance instead", async () => {
    // The OS-level switch is invisible to the browser API on some platforms (Android's per-app switch for the browser): Notification.permission stays
    // "granted". What the app CAN see is that the backend cannot reach the device; the notice then also tells the user to check the phone's own setting.
    installedAs("android")
    device({ permission: "granted", subscribed: true, endpoint: ANDROID })
    backend.stored = { endpoint: ANDROID }
    backend.inactive = true // the push service reported the registration gone
    render(<PushPermissionNotice />)

    const notice = await screen.findByRole("status")
    expect(notice).toHaveTextContent("also check that notifications for OshiYobi are on in your phone's Settings")
  })
})

// ============ 2. subscription recovery ============

describe("recovery of an inactive or missing subscription", () => {
  it.each([
    ["iphone", IOS, IOS_RENEWED],
    ["android", ANDROID, ANDROID_RENEWED],
  ] as const)("%s: a subscription the backend marked inactive is NOT healthy; ON renews it (new endpoint), registers it, and confirms it", async (platform, dead, fresh) => {
    installedAs(platform)
    const push = device({ permission: "granted", subscribed: true, endpoint: dead, renewedEndpoints: [fresh] })
    backend.stored = { endpoint: dead }
    backend.inactive = true
    render(<PushPermissionHost />)

    await expect(ensurePushEnabled()).resolves.toBe("ready")

    expect(push.device.subscription).not.toBeNull()
    expect(backend.stored?.endpoint).toBe(fresh) // the dead endpoint was replaced, not "revived"
    expect(backend.inactive).toBe(false)
    expect(await checkPushHealth()).toBe("healthy")
  })

  it("the browser hands out the SAME rejected subscription again: never reported as ON, the inactive record is left exactly as it was", async () => {
    device({ permission: "granted", subscribed: true, endpoint: IOS, renewedEndpoints: [IOS] })
    backend.stored = { endpoint: IOS }
    backend.inactive = true
    render(<PushPermissionHost />)

    await expect(ensurePushEnabled()).resolves.toBe("failed")

    expect(await screen.findByRole("dialog", { name: "Couldn't turn on notifications" })).toHaveTextContent("stale-subscription")
    expect(writes()).toEqual([]) // no PUT (it would have cleared the marker and made a dead endpoint look healthy), no DELETE
    expect(backend.inactive).toBe(true)
  })

  it("removing the inactive marker alone does not make a subscription healthy: a stored endpoint the browser no longer has is a mismatch", async () => {
    device({ permission: "granted", subscribed: true, endpoint: IOS_RENEWED })
    backend.stored = { endpoint: IOS } // an old registration, marker gone
    expect(await checkPushHealth()).toBe("endpoint-mismatch")

    render(<PushPermissionHost />)
    await expect(ensurePushEnabled()).resolves.toBe("ready")
    expect(backend.stored?.endpoint).toBe(IOS_RENEWED)
  })

  it("the browser has a subscription the backend never received (a lost write): ON registers it and confirms it", async () => {
    const push = device({ permission: "granted", subscribed: true, endpoint: ANDROID })
    expect(await checkPushHealth()).toBe("not-registered")

    render(<PushPermissionHost />)
    await expect(ensurePushEnabled()).resolves.toBe("ready")

    expect(push.subscribe).not.toHaveBeenCalled() // the working browser subscription is kept
    expect(backend.stored?.endpoint).toBe(ANDROID)
  })
})

// ============ 3. failed registration: never shown as ON ============

describe("failed registration is never shown as ON", () => {
  it("the subscription write is rejected (HTTP 500): failed with its step and status, the browser subscription removed, the preference undone", async () => {
    const push = device({ permission: "granted", subscribed: false, endpoint: IOS })
    backend.failures.push({ match: /PUT \/clients\/:id\/push-subscription/, status: 500, times: 1 })
    render(<PushPermissionHost />)

    await expect(ensurePushEnabled()).resolves.toBe("failed")

    expect(await screen.findByRole("dialog", { name: "Couldn't turn on notifications" })).toHaveTextContent("register-subscription / 500")
    expect(push.device.subscription).toBeNull()
    expect(backend.stored).toBeNull()
  })

  it("the write 'succeeds' but the backend does not hold this browser's subscription afterwards (confirming read disagrees): failed, undone, never ready", async () => {
    const push = device({ permission: "granted", subscribed: false, endpoint: IOS })
    // The backend answers the confirming read with some OTHER endpoint (a stale replica, a lost write).
    const real = vi.mocked(apiClient.apiRequest).getMockImplementation()!
    vi.mocked(apiClient.apiRequest).mockImplementation(async (path: string, init?: unknown) => {
      const out = await real(path, init as never)
      return typeof path === "string" && path.includes("key=pushSubscription") && backend.calls.filter((c) => c.startsWith("PUT") && c.includes("push-subscription")).length > 0
        ? { configs: [{ key: "pushSubscription", value: { endpoint: "https://web.push.apple.com/OTHER" }, updatedAt: "t" }] }
        : out
    })
    render(<PushPermissionHost />)

    await expect(ensurePushEnabled()).resolves.toBe("failed")

    expect(await screen.findByRole("dialog", { name: "Couldn't turn on notifications" })).toHaveTextContent("verify-subscription")
    expect(push.device.subscription).toBeNull()
  })

  it("the backend cannot be read at all (offline): failed, nothing written, and a possibly WORKING subscription is not torn down", async () => {
    const push = device({ permission: "granted", subscribed: true, endpoint: ANDROID })
    backend.stored = { endpoint: ANDROID }
    backend.failures.push({ match: /GET \/remote-config/, times: 5 })
    render(<PushPermissionHost />)

    await expect(ensurePushEnabled()).resolves.toBe("failed")

    expect(await screen.findByRole("dialog", { name: "Couldn't turn on notifications" })).toBeInTheDocument()
    expect(push.device.subscription).not.toBeNull()
    expect(writes()).toEqual([])
  })

  it("the browser cannot subscribe (service worker never activates): failed at 'subscribe', nothing written to the backend", async () => {
    const push = device({ permission: "granted", subscribed: false })
    push.subscribe.mockRejectedValueOnce(new Error("AbortError: no active Service Worker"))
    render(<PushPermissionHost />)

    await expect(ensurePushEnabled()).resolves.toBe("failed")

    expect(await screen.findByRole("dialog", { name: "Couldn't turn on notifications" })).toHaveTextContent("subscribe")
    expect(writes()).toEqual([])
  })
})

// ============ 4. the notice: a granted-but-unreachable device is said out loud ============

describe("the Notification Settings notice", () => {
  it.each(["inactive", "not-registered", "endpoint-mismatch"] as const)("shows the repair notice when the backend says %s, and Reconnect repairs it and the notice disappears", async (kind) => {
    const push = device({ permission: "granted", subscribed: true, endpoint: IOS, renewedEndpoints: [IOS_RENEWED] })
    if (kind === "inactive") Object.assign(backend, { stored: { endpoint: IOS }, inactive: true })
    if (kind === "endpoint-mismatch") backend.stored = { endpoint: "https://web.push.apple.com/OLD" }
    const user = userEvent.setup()
    render(<PushPermissionNotice />)

    const notice = await screen.findByRole("status")
    expect(notice).toHaveTextContent("This device may not receive notifications")
    await user.click(screen.getByRole("button", { name: "Reconnect" }))

    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument())
    expect(push.requestPermission).not.toHaveBeenCalled() // reconnecting never prompts: permission is already granted
    expect(await checkPushHealth()).toBe("healthy")
  })

  it("says nothing when the device is healthy, when the backend cannot be read (no false alarm offline), when not subscribed, and shows the denied notice instead when denied", async () => {
    device({ permission: "granted", subscribed: true, endpoint: IOS })
    backend.stored = { endpoint: IOS }
    const view = render(<PushPermissionNotice />)
    await waitFor(() => expect(backend.calls.some((c) => c.startsWith("GET /remote-config"))).toBe(true))
    expect(screen.queryByRole("status")).not.toBeInTheDocument() // healthy

    view.unmount()
    resetPushStateForTests()
    backend.failures.push({ match: /GET \/remote-config/, times: 5 })
    backend.inactive = true
    render(<PushPermissionNotice />)
    await waitFor(() => expect(backend.calls.filter((c) => c.startsWith("GET /remote-config")).length).toBeGreaterThan(1))
    expect(screen.queryByRole("status")).not.toBeInTheDocument() // unknown is not an alarm
  })

  it("denied permission still shows the existing denied notice, not the repair one", async () => {
    device({ permission: "denied" })
    render(<PushPermissionNotice />)

    expect(await screen.findByRole("status")).toHaveTextContent("Notification permission is off")
  })
})

// ============ 5. the health check itself ============

describe("checkPushHealth", () => {
  it("is healthy only when the browser subscription and the ACTIVE backend record are the same endpoint", async () => {
    device({ permission: "granted", subscribed: true, endpoint: ANDROID })
    backend.stored = { endpoint: ANDROID }
    expect(await checkPushHealth()).toBe("healthy")
    backend.inactive = true
    expect(await checkPushHealth()).toBe("inactive")
    backend.inactive = false
    backend.stored = null
    expect(await checkPushHealth()).toBe("not-registered")
  })

  it("no browser subscription / unreadable backend are reported as such, never as healthy", async () => {
    device({ permission: "granted", subscribed: false })
    expect(await checkPushHealth()).toBe("no-browser-subscription")
    fake?.restore()
    device({ permission: "granted", subscribed: true })
    backend.failures.push({ match: /GET \/remote-config/, times: 1 })
    expect(await checkPushHealth()).toBe("unknown")
  })
})
