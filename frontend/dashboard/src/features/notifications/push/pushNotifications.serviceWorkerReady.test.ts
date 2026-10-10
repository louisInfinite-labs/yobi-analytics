import { afterEach, describe, expect, it, vi } from "vitest"
import { subscribeToPush } from "./pushNotifications"

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, "serviceWorker")
})

type WorkerState = "installing" | "installed" | "activating" | "activated" | "redundant"

/** A fake ServiceWorker whose `state` can be advanced and whose statechange listeners fire like the real one. */
function fakeWorker(initial: WorkerState) {
  const listeners = new Set<() => void>()
  const worker = {
    state: initial,
    addEventListener: vi.fn((_type: string, cb: () => void) => listeners.add(cb)),
    removeEventListener: vi.fn((_type: string, cb: () => void) => listeners.delete(cb)),
    advance(next: WorkerState) {
      worker.state = next
      for (const cb of [...listeners]) cb()
    },
  }
  return worker
}

const SUBSCRIPTION_JSON = { endpoint: "https://fcm.example.com/abc", keys: { p256dh: "p", auth: "a" } }

/** Wires up the browser globals around a fake registration; returns spies in call order. */
function setup(registration: Record<string, unknown>, extraNavigator: Record<string, unknown> = {}) {
  const order: string[] = []
  const subscribe = vi.fn(async () => {
    order.push("subscribe")
    return { toJSON: () => SUBSCRIPTION_JSON }
  })
  const pushManager = { getSubscription: vi.fn().mockResolvedValue(null), subscribe }
  const register = vi.fn(async () => {
    order.push("register")
    return { pushManager, ...registration }
  })
  Object.defineProperty(navigator, "serviceWorker", { value: { register, ...extraNavigator }, configurable: true })
  vi.stubGlobal("PushManager", class {})
  vi.stubGlobal("Notification", { requestPermission: vi.fn().mockResolvedValue("granted") })
  return { order, subscribe, register }
}

describe("subscribeToPush service worker readiness", () => {
  it("does not subscribe while the worker is still installing, then subscribes once it activates", async () => {
    const installing = fakeWorker("installing")
    const { subscribe } = setup({ installing, active: null, waiting: null })

    const pending = subscribeToPush("SGVsbG8")
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(subscribe).not.toHaveBeenCalled()

    installing.advance("installed")
    await Promise.resolve()
    expect(subscribe).not.toHaveBeenCalled()

    installing.advance("activating")
    await Promise.resolve()
    expect(subscribe).not.toHaveBeenCalled()

    installing.advance("activated")
    await expect(pending).resolves.toEqual(SUBSCRIPTION_JSON)
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it("subscribes immediately when the registration already has an activated worker", async () => {
    const { order, subscribe } = setup({ active: fakeWorker("activated") })

    await expect(subscribeToPush("SGVsbG8")).resolves.toEqual(SUBSCRIPTION_JSON)

    expect(order).toEqual(["register", "subscribe"])
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it("waits for an active worker that is still activating", async () => {
    const active = fakeWorker("activating")
    const { subscribe } = setup({ active })

    const pending = subscribeToPush("SGVsbG8")
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(subscribe).not.toHaveBeenCalled()

    active.advance("activated")
    await pending
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it("rejects without subscribing when the worker becomes redundant (install failed)", async () => {
    const installing = fakeWorker("installing")
    const { subscribe } = setup({ installing, active: null })

    const pending = subscribeToPush("SGVsbG8")
    const assertion = expect(pending).rejects.toThrow(/redundant/i)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    installing.advance("redundant")

    await assertion
    expect(subscribe).not.toHaveBeenCalled()
  })

  it("stops listening to the worker once it has activated", async () => {
    const installing = fakeWorker("installing")
    setup({ installing, active: null })

    const pending = subscribeToPush("SGVsbG8")
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    installing.advance("activated")
    await pending

    expect(installing.removeEventListener).toHaveBeenCalledWith("statechange", expect.any(Function))
  })

  it("falls back to navigator.serviceWorker.ready when the registration exposes no worker at all", async () => {
    const ready = Promise.resolve({})
    const { order } = setup({}, { ready })

    await subscribeToPush("SGVsbG8")

    expect(order).toEqual(["register", "subscribe"])
  })

  it("propagates a registration failure instead of swallowing it", async () => {
    const register = vi.fn().mockRejectedValue(new Error("SecurityError"))
    Object.defineProperty(navigator, "serviceWorker", { value: { register }, configurable: true })
    vi.stubGlobal("PushManager", class {})
    vi.stubGlobal("Notification", { requestPermission: vi.fn().mockResolvedValue("granted") })

    await expect(subscribeToPush("SGVsbG8")).rejects.toThrow("SecurityError")
  })
})
