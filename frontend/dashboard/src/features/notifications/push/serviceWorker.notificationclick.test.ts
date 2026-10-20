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

/** Runs public/sw.js (plain JS, served as-is) against a fake service-worker scope and taps a notification carrying `data`. `openWindow` can be
 * replaced to simulate a platform that rejects it or hands back no window. */
async function tapNotification(data: unknown, windows: FakeClient[], options: { openWindow?: () => Promise<unknown> } = {}) {
  const source = readFileSync(resolve(__dirname, "../../../../public/sw.js"), "utf-8")
  const listeners: Record<string, (event: unknown) => void> = {}
  const openWindow = vi.fn(options.openWindow ?? (async () => undefined))
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

  it("never follows a cross-origin or malformed route from a payload: it falls back to /", async () => {
    for (const bad of ["https://evil.example.com/x", "//evil.example.com/x", "\\\\evil.example.com\\x", "javascript:alert(1)", "data:text/html,x", 42, "", null, {}]) {
      const { openWindow } = await tapNotification({ url: bad }, [])
      expect(openWindow, String(bad)).toHaveBeenCalledWith("/")
    }
  })
})

/** The payloads the dispatchers send (src/notifications/creator_route.py adds `url`), one per notification kind. */
const CREATOR_PAYLOADS = {
  "advance reminder (30 / 10 / 1 min)": { videoId: "v1", reminderKind: "advance", url: "/creator/aizawa-ema" },
  "live start reminder": { videoId: "v1", reminderKind: "start", url: "/creator/aizawa-ema" },
  "late-discovery catch-up (an advance payload)": { videoId: "v1", reminderKind: "advance", url: "/creator/aizawa-ema" },
  "new video": { videoId: "v1", url: "/creator/aizawa-ema" },
} as const

describe.each(Object.entries(CREATOR_PAYLOADS))("creator deep link: %s", (_kind, payload) => {
  it("app closed: opens exactly one window on the creator Home", async () => {
    const { openWindow, close } = await tapNotification(payload, [])

    expect(close).toHaveBeenCalled()
    expect(openWindow).toHaveBeenCalledTimes(1)
    expect(openWindow).toHaveBeenCalledWith("/creator/aizawa-ema")
  })

  it("app open on another page or creator: navigates that window to the creator Home and focuses it, opening nothing", async () => {
    for (const current of ["/", "/schedule", "/setting", "/creator/usada-pekora"]) {
      const open = fakeClient(current)

      const { openWindow } = await tapNotification(payload, [open])

      expect(open.navigate, current).toHaveBeenCalledWith("/creator/aizawa-ema")
      expect(open.focus, current).toHaveBeenCalledTimes(1)
      expect(openWindow, current).not.toHaveBeenCalled()
    }
  })

  it("app already on that creator Home: only focuses it (no navigation, no new window)", async () => {
    const open = fakeClient("/creator/aizawa-ema")

    const { openWindow } = await tapNotification(payload, [open])

    expect(open.focus).toHaveBeenCalledTimes(1)
    expect(open.navigate).not.toHaveBeenCalled()
    expect(openWindow).not.toHaveBeenCalled()
  })
})

describe("creator deep link: a window that cannot be navigated", () => {
  const payload = { videoId: "v1", reminderKind: "start", url: "/creator/aizawa-ema" }

  it("navigation unsupported: opens the creator Home directly instead of leaving the user on the wrong page", async () => {
    const open = fakeClient("/", { navigable: false })

    const { openWindow } = await tapNotification(payload, [open])

    expect(openWindow).toHaveBeenCalledTimes(1)
    expect(openWindow).toHaveBeenCalledWith("/creator/aizawa-ema")
    expect(open.focus).not.toHaveBeenCalled() // the opened window is the one the user sees; the old one is not pulled in front of it
  })

  it("navigation rejects: opens the creator Home directly", async () => {
    const open = fakeClient("/")
    open.navigate = vi.fn(async () => {
      throw new Error("navigate refused")
    })

    const { openWindow } = await tapNotification(payload, [open])

    expect(openWindow).toHaveBeenCalledWith("/creator/aizawa-ema")
  })

  it("navigation resolves with no window (refused): opens the creator Home directly", async () => {
    const open = fakeClient("/")
    open.navigate = vi.fn(async () => null) as unknown as FakeClient["navigate"]

    const { openWindow } = await tapNotification(payload, [open])

    expect(openWindow).toHaveBeenCalledWith("/creator/aizawa-ema")
    expect(open.focus).not.toHaveBeenCalled()
  })

  it("openWindow resolving with no window (iOS-style null) still counts as opened: no extra focus, no second window", async () => {
    const open = fakeClient("/", { navigable: false })

    const { openWindow } = await tapNotification(payload, [open], { openWindow: async () => null })

    expect(openWindow).toHaveBeenCalledTimes(1)
    expect(open.focus).not.toHaveBeenCalled()
  })

  it("neither navigation nor openWindow works: the existing window is still focused where it is", async () => {
    const open = fakeClient("/", { navigable: false })

    const { openWindow } = await tapNotification(payload, [open], {
      openWindow: async () => {
        throw new Error("InvalidAccessError")
      },
    })

    expect(openWindow).toHaveBeenCalledTimes(1)
    expect(open.focus).toHaveBeenCalledTimes(1)
  })

  it("never reaches an untrusted URL through the fallback: a bad route opens the root and never navigates", async () => {
    const open = fakeClient("/", { navigable: true })

    const { openWindow } = await tapNotification({ videoId: "v1", url: "https://evil.example.com/creator/aizawa-ema" }, [open])

    expect(open.navigate).not.toHaveBeenCalled()
    expect(openWindow).not.toHaveBeenCalled()
    expect(open.focus).toHaveBeenCalledTimes(1)
  })
})

describe("creator deep link: missing or unusable creator information", () => {
  it("a payload without a route (older notification, unknown/inactive creator) just opens or focuses the app as before", async () => {
    const { openWindow } = await tapNotification({ videoId: "v1", reminderKind: "start" }, [])
    expect(openWindow).toHaveBeenCalledWith("/")

    const open = fakeClient("/schedule")
    await tapNotification({ videoId: "v1", reminderKind: "start" }, [open])
    expect(open.focus).toHaveBeenCalledTimes(1)
    expect(open.navigate).not.toHaveBeenCalled()
  })

  it("an invalid creator slug is still delivered to the app as a same-origin path: the app itself falls back to / (see creatorRouting.test.ts)", async () => {
    const { openWindow } = await tapNotification({ videoId: "v1", url: "/creator/not-a-creator" }, [])

    expect(openWindow).toHaveBeenCalledWith("/creator/not-a-creator") // same-origin, so allowed; Creator routing refuses an unknown slug and shows /
  })

  it("with several open windows only one is used: one navigation, one focus", async () => {
    const first = fakeClient("/schedule")
    const second = fakeClient("/setting")

    const { openWindow } = await tapNotification({ videoId: "v1", url: "/creator/aizawa-ema" }, [first, second])

    expect(first.navigate).toHaveBeenCalledTimes(1)
    expect(second.navigate).not.toHaveBeenCalled()
    expect(second.focus).not.toHaveBeenCalled()
    expect(openWindow).not.toHaveBeenCalled()
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

describe("video deep link: a video notification asks the app for that exact video (/creator/<slug>?video=<id>)", () => {
  const VIDEO = "dQw4w9WgXcQ"
  const CREATOR = "/creator/aizawa-ema"
  const WITH_VIDEO = `${CREATOR}?video=${VIDEO}`

  it("cold start (app closed): opens one window directly on the creator route carrying the exact video id", async () => {
    const { openWindow } = await tapNotification({ videoId: VIDEO, url: CREATOR }, [])

    expect(openWindow).toHaveBeenCalledTimes(1)
    expect(openWindow).toHaveBeenCalledWith(WITH_VIDEO)
  })

  it("existing tab on another page or creator: navigates that tab to the exact-video route and focuses it, opening nothing", async () => {
    const open = fakeClient("/schedule")

    const { openWindow } = await tapNotification({ videoId: VIDEO, url: CREATOR }, [open])

    expect(open.navigate).toHaveBeenCalledWith(WITH_VIDEO)
    expect(open.focus).toHaveBeenCalledTimes(1)
    expect(openWindow).not.toHaveBeenCalled()
  })

  it("existing tab already on that creator Home (parameter already consumed): it is still navigated, because the video itself is what the tap asks for", async () => {
    const open = fakeClient(CREATOR)

    await tapNotification({ videoId: VIDEO, url: CREATOR }, [open])

    expect(open.navigate).toHaveBeenCalledWith(WITH_VIDEO)
  })

  it("a tab that is already showing the exact deep-link URL is only focused (no navigation, no new window)", async () => {
    const open = fakeClient(WITH_VIDEO)

    const { openWindow } = await tapNotification({ videoId: VIDEO, url: CREATOR }, [open])

    expect(open.navigate).not.toHaveBeenCalled()
    expect(open.focus).toHaveBeenCalledTimes(1)
    expect(openWindow).not.toHaveBeenCalled()
  })

  it("every video-specific kind (new upload, live start, advance and catch-up reminders) carries the same payload shape and gets the same route", async () => {
    for (const reminderKind of [undefined, "start", "advance", "late_discovery"]) {
      const { openWindow } = await tapNotification({ videoId: VIDEO, url: CREATOR, reminderKind, image: `https://i.ytimg.com/vi/${VIDEO}/hqdefault.jpg` }, [])
      expect(openWindow).toHaveBeenCalledWith(WITH_VIDEO)
    }
  })

  it("an installed PWA window that cannot be navigated gets the exact-video route through openWindow", async () => {
    const pwa = fakeClient("/schedule", { navigable: false })

    const { openWindow } = await tapNotification({ videoId: VIDEO, url: CREATOR }, [pwa])

    expect(openWindow).toHaveBeenCalledWith(WITH_VIDEO)
  })

  it("duplicate clicks on the same notification never open more than one window and always land on the same route", async () => {
    const open = fakeClient("/schedule")

    await tapNotification({ videoId: VIDEO, url: CREATOR }, [open])
    const second = await tapNotification({ videoId: VIDEO, url: CREATOR }, [open])

    expect(open.navigate).toHaveBeenCalledTimes(2)
    expect(open.navigate).toHaveBeenNthCalledWith(1, WITH_VIDEO)
    expect(open.navigate).toHaveBeenNthCalledWith(2, WITH_VIDEO)
    expect(second.openWindow).not.toHaveBeenCalled()
  })

  it("a creator-only notification (no videoId) keeps the plain creator route", async () => {
    const { openWindow } = await tapNotification({ url: CREATOR }, [])
    expect(openWindow).toHaveBeenCalledWith(CREATOR)
  })

  it("an invalid videoId is never put in the URL: the plain creator route is used", async () => {
    for (const videoId of ["v1", "", "short", "twelve_chars!", `${VIDEO}x`, "dQw4w9WgXc/", "a&b=c#d.e/f", "../..//etc", 12345678901, null, undefined, { id: VIDEO }]) {
      const { openWindow } = await tapNotification({ videoId, url: CREATOR }, [])
      expect(openWindow, String(videoId)).toHaveBeenCalledWith(CREATOR)
    }
  })

  it("a videoId only ever rides on a creator Home route: other routes, no route and cross-origin routes are unchanged", async () => {
    expect((await tapNotification({ videoId: VIDEO, url: "/schedule" }, [])).openWindow).toHaveBeenCalledWith("/schedule")
    expect((await tapNotification({ videoId: VIDEO, url: `${CREATOR}?x=1` }, [])).openWindow).toHaveBeenCalledWith(`${CREATOR}?x=1`)
    expect((await tapNotification({ videoId: VIDEO }, [])).openWindow).toHaveBeenCalledWith("/")
    expect((await tapNotification({ videoId: VIDEO, url: `https://evil.example${CREATOR}` }, [])).openWindow).toHaveBeenCalledWith("/")
  })

  it("an invalid creator slug is still only a same-origin path with the id attached to nothing: it falls back as before", async () => {
    expect((await tapNotification({ videoId: VIDEO, url: "/creator/Not_A_Slug" }, [])).openWindow).toHaveBeenCalledWith("/creator/Not_A_Slug")
    expect((await tapNotification({ videoId: VIDEO, url: "/creator/" }, [])).openWindow).toHaveBeenCalledWith("/creator/")
  })
})