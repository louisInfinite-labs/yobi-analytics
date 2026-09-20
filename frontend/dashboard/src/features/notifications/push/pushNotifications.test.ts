import { afterEach, describe, expect, it, vi } from "vitest"
import {
  getPushSubscriptionStatus,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
  urlBase64ToUint8Array,
} from "./pushNotifications"

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, "serviceWorker")
})

/** A minimal fake PushSubscription, overriding only the given fields. */
function fakeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    toJSON: () => ({ endpoint: "https://fcm.example.com/abc", keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

describe("urlBase64ToUint8Array", () => {
  it("decodes a URL-safe base64 string (needing padding) into its bytes", () => {
    // "SGVsbG8" is "Hello" base64-encoded with the "=" padding stripped —
    // exercises both the base64 decode and the padding-restoration math.
    expect(urlBase64ToUint8Array("SGVsbG8")).toEqual(Uint8Array.from([72, 101, 108, 108, 111]))
  })
})

describe("isPushSupported", () => {
  it("is false when serviceWorker is missing from navigator", () => {
    vi.stubGlobal("PushManager", class {})
    vi.stubGlobal("Notification", {})
    expect(isPushSupported()).toBe(false)
  })

  it("is false when PushManager is missing from window", () => {
    Object.defineProperty(navigator, "serviceWorker", { value: {}, configurable: true })
    vi.stubGlobal("Notification", {})
    expect(isPushSupported()).toBe(false)
  })

  it("is false when Notification is missing from window", () => {
    Object.defineProperty(navigator, "serviceWorker", { value: {}, configurable: true })
    vi.stubGlobal("PushManager", class {})
    expect(isPushSupported()).toBe(false)
  })

  it("is true when all three APIs are present", () => {
    Object.defineProperty(navigator, "serviceWorker", { value: {}, configurable: true })
    vi.stubGlobal("PushManager", class {})
    vi.stubGlobal("Notification", {})
    expect(isPushSupported()).toBe(true)
  })
})

describe("subscribeToPush", () => {
  it("returns null when push is not supported, without touching Notification", async () => {
    const requestPermission = vi.fn()
    vi.stubGlobal("Notification", { requestPermission })

    const result = await subscribeToPush("SGVsbG8")

    expect(result).toBeNull()
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it("returns null when the user denies the permission prompt", async () => {
    Object.defineProperty(navigator, "serviceWorker", { value: { register: vi.fn() }, configurable: true })
    vi.stubGlobal("PushManager", class {})
    vi.stubGlobal("Notification", { requestPermission: vi.fn().mockResolvedValue("denied") })

    expect(await subscribeToPush("SGVsbG8")).toBeNull()
  })

  it("subscribes and returns the subscription JSON when none exists yet", async () => {
    const subscribeMock = vi.fn().mockResolvedValue(fakeSubscription())
    const pushManager = { getSubscription: vi.fn().mockResolvedValue(null), subscribe: subscribeMock }
    const register = vi.fn().mockResolvedValue({ pushManager })
    Object.defineProperty(navigator, "serviceWorker", { value: { register }, configurable: true })
    vi.stubGlobal("PushManager", class {})
    vi.stubGlobal("Notification", { requestPermission: vi.fn().mockResolvedValue("granted") })

    const result = await subscribeToPush("SGVsbG8")

    expect(result).toEqual({ endpoint: "https://fcm.example.com/abc", keys: { p256dh: "p", auth: "a" } })
    expect(subscribeMock).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) }),
    )
  })

  it("reuses an already-existing subscription instead of subscribing again", async () => {
    const subscribeMock = vi.fn()
    const pushManager = { getSubscription: vi.fn().mockResolvedValue(fakeSubscription()), subscribe: subscribeMock }
    const register = vi.fn().mockResolvedValue({ pushManager })
    Object.defineProperty(navigator, "serviceWorker", { value: { register }, configurable: true })
    vi.stubGlobal("PushManager", class {})
    vi.stubGlobal("Notification", { requestPermission: vi.fn().mockResolvedValue("granted") })

    const result = await subscribeToPush("SGVsbG8")

    expect(result).toEqual({ endpoint: "https://fcm.example.com/abc", keys: { p256dh: "p", auth: "a" } })
    expect(subscribeMock).not.toHaveBeenCalled()
  })
})

describe("getPushSubscriptionStatus", () => {
  it("is 'unsupported' when push is not supported", async () => {
    expect(await getPushSubscriptionStatus()).toBe("unsupported")
  })

  it("is 'unsubscribed' when supported but no subscription exists", async () => {
    const pushManager = { getSubscription: vi.fn().mockResolvedValue(null) }
    Object.defineProperty(navigator, "serviceWorker", {
      value: { getRegistration: vi.fn().mockResolvedValue({ pushManager }) },
      configurable: true,
    })
    vi.stubGlobal("PushManager", class {})
    vi.stubGlobal("Notification", {})

    expect(await getPushSubscriptionStatus()).toBe("unsubscribed")
  })

  it("is 'unsubscribed' when there is no registration at all", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      value: { getRegistration: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    })
    vi.stubGlobal("PushManager", class {})
    vi.stubGlobal("Notification", {})

    expect(await getPushSubscriptionStatus()).toBe("unsubscribed")
  })

  it("is 'subscribed' when a subscription already exists", async () => {
    const pushManager = { getSubscription: vi.fn().mockResolvedValue(fakeSubscription()) }
    Object.defineProperty(navigator, "serviceWorker", {
      value: { getRegistration: vi.fn().mockResolvedValue({ pushManager }) },
      configurable: true,
    })
    vi.stubGlobal("PushManager", class {})
    vi.stubGlobal("Notification", {})

    expect(await getPushSubscriptionStatus()).toBe("subscribed")
  })
})

describe("unsubscribeFromPush", () => {
  it("returns false when serviceWorker is not supported", async () => {
    expect(await unsubscribeFromPush()).toBe(false)
  })

  it("returns false when there is no service worker registration", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      value: { getRegistration: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    })

    expect(await unsubscribeFromPush()).toBe(false)
  })

  it("returns false when the registration has no active subscription", async () => {
    const pushManager = { getSubscription: vi.fn().mockResolvedValue(null) }
    Object.defineProperty(navigator, "serviceWorker", {
      value: { getRegistration: vi.fn().mockResolvedValue({ pushManager }) },
      configurable: true,
    })

    expect(await unsubscribeFromPush()).toBe(false)
  })

  it("unsubscribes and returns true when a subscription exists", async () => {
    const subscription = fakeSubscription()
    const pushManager = { getSubscription: vi.fn().mockResolvedValue(subscription) }
    Object.defineProperty(navigator, "serviceWorker", {
      value: { getRegistration: vi.fn().mockResolvedValue({ pushManager }) },
      configurable: true,
    })

    expect(await unsubscribeFromPush()).toBe(true)
    expect(subscription.unsubscribe).toHaveBeenCalled()
  })
})
