import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"

interface FakeClient {
  url: string
  focus: ReturnType<typeof vi.fn>
  navigate?: ReturnType<typeof vi.fn>
}

const ORIGIN = "https://oshiyobi.web.app"

function fakeClient(url: string, options: { navigable?: boolean } = {}): FakeClient {
  const client: FakeClient = { url: `${ORIGIN}${url}`, focus: vi.fn(async () => client) }
  if (options.navigable !== false) client.navigate = vi.fn(async () => client)
  return client
}

/** Runs public/sw.js (plain JS, served as-is) against a fake service-worker scope and taps a notification carrying `data`. */
async function tapNotification(data: unknown, windows: FakeClient[]) {
  const source = readFileSync(resolve(__dirname, "../../../../public/sw.js"), "utf-8")
  const listeners: Record<string, (event: unknown) => void> = {}
  const openWindow = vi.fn(async () => undefined)
  const scope = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[type] = listener
    },
    location: { origin: ORIGIN },
    skipWaiting: vi.fn(),
    registration: { showNotification: vi.fn() },
    clients: { matchAll: vi.fn(async () => windows), openWindow, claim: vi.fn(async () => undefined) },
  }
  new Function("self", source)(scope)

  const close = vi.fn()
  let work: Promise<unknown> = Promise.resolve()
  listeners["notificationclick"]({ notification: { data, close }, waitUntil: (promise: Promise<unknown>) => (work = promise) })
  await work
  return { close, openWindow, scope }
}

describe("service worker notificationclick", () => {
  it("closes the notification and focuses an already-open OshiYobi window instead of opening another", async () => {
    const open = fakeClient("/schedule")

    const { close, openWindow } = await tapNotification({ videoId: "v1" }, [open])

    expect(close).toHaveBeenCalled()
    expect(open.focus).toHaveBeenCalledTimes(1)
    expect(open.navigate).not.toHaveBeenCalled() // no payload route: the window keeps the page the user was on
    expect(openWindow).not.toHaveBeenCalled()
  })

  it("opens OshiYobi at / when no window is open and the payload has no route (today's { videoId } payloads)", async () => {
    const { openWindow } = await tapNotification({ videoId: "v1" }, [])

    expect(openWindow).toHaveBeenCalledTimes(1)
    expect(openWindow).toHaveBeenCalledWith("/")
  })

  it("also opens / when the notification has no data at all", async () => {
    const { openWindow } = await tapNotification(undefined, [])

    expect(openWindow).toHaveBeenCalledWith("/")
  })

  it("opens the creator Home route from the payload when no window is open", async () => {
    const { openWindow } = await tapNotification({ videoId: "v1", url: "/creator/aizawa-ema" }, [])

    expect(openWindow).toHaveBeenCalledWith("/creator/aizawa-ema")
  })

  it("moves an already-open window to the payload's creator route and focuses it", async () => {
    const open = fakeClient("/")

    const { openWindow } = await tapNotification({ path: "/creator/aizawa-ema" }, [open])

    expect(open.navigate).toHaveBeenCalledWith("/creator/aizawa-ema")
    expect(open.focus).toHaveBeenCalled()
    expect(openWindow).not.toHaveBeenCalled()
  })

  it("prefers a window that is already on the payload's route, without navigating anything", async () => {
    const other = fakeClient("/schedule")
    const onRoute = fakeClient("/creator/aizawa-ema")

    await tapNotification({ url: "/creator/aizawa-ema" }, [other, onRoute])

    expect(onRoute.focus).toHaveBeenCalledTimes(1)
    expect(onRoute.navigate).not.toHaveBeenCalled()
    expect(other.focus).not.toHaveBeenCalled()
  })

  it("keeps the root and the other existing routes working as payload routes (/, /schedule, query strings)", async () => {
    for (const route of ["/", "/schedule", "/creator/aizawa-ema?x=1"]) {
      const { openWindow } = await tapNotification({ url: route }, [])
      expect(openWindow).toHaveBeenCalledWith(route)
    }
  })

  it("falls back to focusing the window where it is when it cannot be navigated", async () => {
    const open = fakeClient("/", { navigable: false })

    await tapNotification({ url: "/creator/aizawa-ema" }, [open])

    expect(open.focus).toHaveBeenCalledTimes(1)
  })

  it("never follows a cross-origin or malformed route from a payload: it falls back to /", async () => {
    for (const bad of ["https://evil.example.com/x", "//evil.example.com/x", "javascript:alert(1)", 42, "", null]) {
      const { openWindow } = await tapNotification({ url: bad }, [])
      expect(openWindow, String(bad)).toHaveBeenCalledWith("/")
    }
  })
})

describe("service worker lifecycle", () => {
  it("takes over immediately on install and claims open pages on activate (it holds no caches, so there is no old/new asset mix to guard)", () => {
    const source = readFileSync(resolve(__dirname, "../../../../public/sw.js"), "utf-8")
    const listeners: Record<string, (event: unknown) => void> = {}
    const skipWaiting = vi.fn()
    const claim = vi.fn(async () => undefined)
    new Function("self", source)({
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners[type] = listener
      },
      skipWaiting,
      clients: { claim },
      location: { origin: ORIGIN },
    })

    listeners["install"]({})
    expect(skipWaiting).toHaveBeenCalledTimes(1)

    const waitUntil = vi.fn()
    listeners["activate"]({ waitUntil })
    expect(claim).toHaveBeenCalledTimes(1)
    expect(waitUntil).toHaveBeenCalledTimes(1)
  })

  it("has no fetch listener: every request goes to the network", () => {
    const source = readFileSync(resolve(__dirname, "../../../../public/sw.js"), "utf-8")
    const types: string[] = []
    new Function("self", source)({ addEventListener: (type: string) => types.push(type), location: { origin: ORIGIN } })

    expect(types.sort()).toEqual(["activate", "install", "notificationclick", "push"])
  })
})
