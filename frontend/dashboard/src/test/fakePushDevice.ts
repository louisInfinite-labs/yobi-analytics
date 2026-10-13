import { vi } from "vitest"

export interface FakePushDeviceOptions {
  /** Notification.permission at the start. */
  permission?: NotificationPermission
  /** What the browser prompt answers when Notification.requestPermission() runs. */
  promptAnswer?: NotificationPermission
  /** Start with a PushSubscription already on the registration. */
  subscribed?: boolean
}

const SUBSCRIPTION_JSON = { endpoint: "https://fcm.example.com/device-1", keys: { p256dh: "p", auth: "a" } }

/** A browser that supports Web Push, with every moving part observable: Notification (permission + prompt), PushManager, and a service
 * worker container whose one registration holds the subscription. Installs itself on the jsdom globals; call restore() (or
 * vi.unstubAllGlobals) in afterEach. `device.permission` / `device.subscription` can be changed mid-test to simulate the user changing
 * the device's settings while the app is in the background. */
export function installFakePushDevice(options: FakePushDeviceOptions = {}) {
  const device = {
    permission: options.permission ?? "default",
    subscription: options.subscribed ? { toJSON: () => SUBSCRIPTION_JSON, unsubscribe: vi.fn(async () => true) } : (null as null | { toJSON: () => unknown; unsubscribe: () => Promise<boolean> }),
  }
  const requestPermission = vi.fn(async () => {
    device.permission = options.promptAnswer ?? "granted"
    return device.permission
  })
  const subscribe = vi.fn(async () => {
    device.subscription = {
      toJSON: () => SUBSCRIPTION_JSON,
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
