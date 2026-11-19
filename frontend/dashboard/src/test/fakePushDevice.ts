import { vi } from "vitest"

export interface FakePushDeviceOptions {
  /** Notification.permission at the start. */
  permission?: NotificationPermission
  /** What the browser prompt answers when Notification.requestPermission() runs. */
  promptAnswer?: NotificationPermission
  /** Start with a PushSubscription already on the registration. */
  subscribed?: boolean
  /** The push service the subscription points to (default: Chrome / FCM). iOS and iPadOS Home Screen apps use https://web.push.apple.com/... */
  endpoint?: string
  /** Endpoints handed out by the NEXT calls to subscribe() (a browser that renews a subscription gets a new one); once used up, subscribe() keeps returning `endpoint`. */
  renewedEndpoints?: string[]
}

const DEFAULT_ENDPOINT = "https://fcm.example.com/device-1"

/** A browser that supports Web Push, with every moving part observable: Notification (permission + prompt), PushManager, and a service
 * worker container whose one registration holds the subscription. Installs itself on the jsdom globals; call restore() (or
 * vi.unstubAllGlobals) in afterEach. `device.permission` / `device.subscription` can be changed mid-test to simulate the user changing
 * the device's settings while the app is in the background. */
export function installFakePushDevice(options: FakePushDeviceOptions = {}) {
  const SUBSCRIPTION_JSON = { endpoint: options.endpoint ?? DEFAULT_ENDPOINT, keys: { p256dh: "p", auth: "a" } }
  const renewed = [...(options.renewedEndpoints ?? [])]
  const device = {
    permission: options.permission ?? "default",
    subscription: null as null | { toJSON: () => unknown; unsubscribe: () => Promise<boolean> },
  }
  // A real PushSubscription.unsubscribe() removes the subscription from the registration, so the next getSubscription() is null.
  if (options.subscribed) {
    device.subscription = {
      toJSON: () => SUBSCRIPTION_JSON,
      unsubscribe: vi.fn(async () => {
        device.subscription = null
        return true
      }),
    }
  }
  const requestPermission = vi.fn(async () => {
    device.permission = options.promptAnswer ?? "granted"
    return device.permission
  })
  const subscribe = vi.fn(async () => {
    const created = { ...SUBSCRIPTION_JSON, endpoint: renewed.shift() ?? SUBSCRIPTION_JSON.endpoint }
    device.subscription = {
      toJSON: () => created,
      unsubscribe: vi.fn(async () => {
        device.subscription = null
        return true
      }),
    }
    return device.subscription
  })
  const getSubscription = vi.fn(async () => device.subscription)
  const registration = { active: { state: "activated" }, waiting: null, installing: null, pushManager: { getSubscription, subscribe }, update: vi.fn(async () => undefined) }
  const register = vi.fn(async () => registration)
  const getRegistration = vi.fn(async () => registration)

  const NotificationStub = Object.defineProperty({ requestPermission }, "permission", { get: () => device.permission })
  vi.stubGlobal("Notification", NotificationStub)
  vi.stubGlobal("PushManager", class {})
  Object.defineProperty(navigator, "serviceWorker", { value: { register, getRegistration, ready: Promise.resolve(registration) }, configurable: true })

  return {
    device,
    requestPermission,
    subscribe,
    getSubscription,
    register,
    registration,
    restore() {
      vi.unstubAllGlobals()
      Reflect.deleteProperty(navigator, "serviceWorker")
    },
  }
}
