import { afterEach, describe, expect, it, vi } from "vitest"
import { registerServiceWorker, startServiceWorker } from "./registerServiceWorker"

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, "serviceWorker")
  vi.restoreAllMocks()
})

function installContainer(register: () => Promise<unknown>) {
  const registerSpy = vi.fn(register)
  Object.defineProperty(navigator, "serviceWorker", { value: { register: registerSpy }, configurable: true })
  return registerSpy
}

describe("registerServiceWorker", () => {
  it("registers the ONE service worker, /sw.js at scope /, and bypasses the HTTP cache for update checks", async () => {
    const register = installContainer(async () => ({ scope: "/" }))

    await registerServiceWorker()

    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" })
  })

  it("never registers twice: start-up and the push subscription flow share one registration", async () => {
    const register = installContainer(async () => ({ scope: "/" }))

    const [first, second] = await Promise.all([registerServiceWorker(), registerServiceWorker()])
    const third = await registerServiceWorker()

    expect(register).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
    expect(third).toBe(first)
  })

  it("does not remember a failed registration: the next caller retries", async () => {
    let attempt = 0
    const register = installContainer(async () => {
      attempt += 1
      if (attempt === 1) throw new Error("install failed")
      return { scope: "/" }
    })

    await expect(registerServiceWorker()).rejects.toThrow("install failed")
    await expect(registerServiceWorker()).resolves.toEqual({ scope: "/" })

    expect(register).toHaveBeenCalledTimes(2)
  })

  it("rejects (rather than throwing synchronously) where service workers are unsupported", async () => {
    await expect(registerServiceWorker()).rejects.toThrow("not supported")
  })
})

describe("startServiceWorker (app start-up)", () => {
  it("registers once at start-up without any notification permission being involved", async () => {
    const register = installContainer(async () => ({ scope: "/", update: vi.fn() }))
    const requestPermission = vi.fn()
    vi.stubGlobal("Notification", { permission: "default", requestPermission })

    startServiceWorker()
    await Promise.resolve()

    expect(register).toHaveBeenCalledTimes(1)
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it("is a silent no-op on a browser without service workers, and swallows a failed registration", async () => {
    expect(() => startServiceWorker()).not.toThrow()

    installContainer(async () => {
      throw new Error("blocked")
    })
    expect(() => startServiceWorker()).not.toThrow()
    await Promise.resolve()
  })

  it("waits for the window load event when the document is still loading", () => {
    const register = installContainer(async () => ({ scope: "/", update: vi.fn() }))
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading")

    startServiceWorker()
    expect(register).not.toHaveBeenCalled()

    window.dispatchEvent(new Event("load"))
    expect(register).toHaveBeenCalledTimes(1)
  })
})
