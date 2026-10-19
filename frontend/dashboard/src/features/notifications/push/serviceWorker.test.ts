import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"

type FakeEventData = { json: () => unknown; text: () => string }

/** Runs public/sw.js (plain JS, served as-is) against a fake service-worker scope and returns what it handed to showNotification. */
function pushThroughServiceWorker(eventData: FakeEventData) {
  const source = readFileSync(resolve(__dirname, "../../../../public/sw.js"), "utf-8")
  const listeners: Record<string, (event: unknown) => void> = {}
  const showNotification = vi.fn().mockResolvedValue(undefined)
  const scope = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[type] = listener
    },
    registration: { showNotification },
    clients: { matchAll: vi.fn(), openWindow: vi.fn() },
  }
  new Function("self", source)(scope)
  listeners["push"]({ data: eventData, waitUntil: () => undefined })
  return { showNotification }
}

const push = (payload: unknown) => pushThroughServiceWorker({ json: () => payload, text: () => JSON.stringify(payload) })

describe("service worker push handler", () => {
  it.each([
    ["zh-TW", "藍沢エマ 發布了新影片", "【新作MV】ありがとう / Original Song"],
    ["ja", "藍沢エマ は10分後に配信開始", "【雑談】のんびりお話しします！ #ぶいすぽ"],
    ["en", "藍沢エマ goes live in 1 hour", "Ranked grind - 深夜ソロ配信"],
  ])("shows the %s title and body exactly as the backend sent them", (_locale, title, body) => {
    const { showNotification } = push({ title, body, data: { videoId: "v1" } })

    expect(showNotification).toHaveBeenCalledTimes(1)
    expect(showNotification).toHaveBeenCalledWith(title, expect.objectContaining({ body, data: { videoId: "v1" } }))
  })

  it("does not trim, translate or otherwise rewrite the original-language video / stream title", () => {
    const original = "  【Apex】ランクマ！  #ぶいすぽ  "

    const { showNotification } = push({ title: "藍沢エマ 已開始直播", body: original })

    expect(showNotification.mock.calls[0][1].body).toBe(original)
  })

  it("only falls back to the app name when the title is entirely missing, and never touches the body", () => {
    const { showNotification } = push({ title: "", body: "直播" })

    expect(showNotification).toHaveBeenCalledWith("OshiYobi", expect.objectContaining({ body: "直播" }))
  })

  it("shows a non-JSON payload as the body of a generic notification instead of crashing", () => {
    const { showNotification } = pushThroughServiceWorker({
      json: () => {
        throw new SyntaxError("not json")
      },
      text: () => "plain text",
    })

    expect(showNotification).toHaveBeenCalledWith("OshiYobi", expect.objectContaining({ body: "plain text" }))
  })
})

/** Pushes a payload through public/sw.js with a showNotification the test controls, and waits for everything the worker passed to waitUntil. */
async function pushAndSettle(payload: unknown, showNotification: (title: string, options: Record<string, unknown>) => Promise<unknown>) {
  const source = readFileSync(resolve(__dirname, "../../../../public/sw.js"), "utf-8")
  const listeners: Record<string, (event: unknown) => void> = {}
  const shown = vi.fn(showNotification)
  new Function("self", source)({
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[type] = listener
    },
    registration: { showNotification: shown },
    clients: { matchAll: vi.fn(), openWindow: vi.fn() },
  })
  let work: Promise<unknown> = Promise.resolve()
  listeners["push"]({ data: { json: () => payload, text: () => JSON.stringify(payload) }, waitUntil: (promise: Promise<unknown>) => (work = promise) })
  await work
  return shown
}

const THUMBNAIL = "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"

describe("service worker push handler: thumbnail image", () => {
  it("maps a valid YouTube thumbnail in the payload's data to the notification's image, and changes nothing else", async () => {
    const data = { videoId: "dQw4w9WgXcQ", reminderKind: "start", url: "/creator/aizawa-ema", image: THUMBNAIL }

    const shown = await pushAndSettle({ title: "藍沢エマ is live", body: "Ranked grind", data }, async () => undefined)

    expect(shown).toHaveBeenCalledTimes(1)
    expect(shown).toHaveBeenCalledWith("藍沢エマ is live", {
      body: "Ranked grind",
      data, // the payload data (route, videoId, ...) reaches notificationclick exactly as sent
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      image: THUMBNAIL,
    })
  })

  it.each(["default", "mqdefault", "hqdefault", "sddefault", "maxresdefault"])("accepts the %s thumbnail size, on i.ytimg.com and img.youtube.com", async (size) => {
    for (const host of ["i.ytimg.com", "img.youtube.com"]) {
      const image = `https://${host}/vi/dQw4w9WgXcQ/${size}.jpg`
      const shown = await pushAndSettle({ title: "t", body: "b", data: { image } }, async () => undefined)
      expect(shown.mock.calls[0][1].image, image).toBe(image)
    }
  })

  it.each([
    ["another host", "https://evil.example.com/vi/dQw4w9WgXcQ/hqdefault.jpg"],
    ["a look-alike host", "https://i.ytimg.com.evil.example.com/vi/dQw4w9WgXcQ/hqdefault.jpg"],
    ["a sub-domain trick", "https://evil.example.com/?x=https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"],
    ["credentials in the URL", "https://user:pw@i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"],
    ["plain http", "http://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"],
    ["a port", "https://i.ytimg.com:8443/vi/dQw4w9WgXcQ/hqdefault.jpg"],
    ["a query string", "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg?track=1"],
    ["a hash", "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg#x"],
    ["another path on YouTube's image host", "https://i.ytimg.com/an/avatar.jpg"],
    ["a path traversal", "https://i.ytimg.com/vi/../evil.jpg"],
    ["a malformed video id", "https://i.ytimg.com/vi/short/hqdefault.jpg"],
    ["an unknown file", "https://i.ytimg.com/vi/dQw4w9WgXcQ/evil.php"],
    ["a protocol-relative URL", "//i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"],
    ["a data: URL", "data:image/png;base64,AAAA"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a relative path", "/icons/icon-512.png"],
    ["a non-string", 42],
    ["an empty string", ""],
  ])("never passes %s to showNotification as the image (the notification is still shown)", async (_label, image) => {
    const shown = await pushAndSettle({ title: "t", body: "b", data: { videoId: "v1", image } }, async () => undefined)

    expect(shown).toHaveBeenCalledTimes(1)
    expect(shown.mock.calls[0][1]).not.toHaveProperty("image")
    expect(shown.mock.calls[0][1].body).toBe("b")
  })

  it("a payload without an image (older notification, unknown video id) is shown exactly as before", async () => {
    const shown = await pushAndSettle({ title: "t", body: "b", data: { videoId: "v1", url: "/creator/aizawa-ema" } }, async () => undefined)

    expect(shown).toHaveBeenCalledTimes(1)
    expect(shown.mock.calls[0][1]).toEqual({ body: "b", data: { videoId: "v1", url: "/creator/aizawa-ema" }, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png" })
  })

  it("if showing with the image is refused, the notification is shown again without it -- an image can never stop a notification", async () => {
    let first = true
    const shown = await pushAndSettle({ title: "t", body: "b", data: { image: THUMBNAIL } }, async (_title, options) => {
      if (first && options.image) {
        first = false
        throw new TypeError("image rejected")
      }
      return undefined
    })

    expect(shown).toHaveBeenCalledTimes(2)
    expect(shown.mock.calls[0][1].image).toBe(THUMBNAIL)
    expect(shown.mock.calls[1][1]).not.toHaveProperty("image")
    expect(shown.mock.calls[1][1].body).toBe("b")
  })

  it("a notification that cannot be shown even without the image still rejects, so a real failure is not hidden", async () => {
    await expect(
      pushAndSettle({ title: "t", body: "b", data: { image: THUMBNAIL } }, async () => {
        throw new Error("permission denied")
      }),
    ).rejects.toThrow("permission denied")
  })

  it("the image does not interfere with the creator deep link on tap (data.url still routes)", async () => {
    const data = { videoId: "dQw4w9WgXcQ", url: "/creator/aizawa-ema", image: THUMBNAIL }
    const shown = await pushAndSettle({ title: "t", body: "b", data }, async () => undefined)

    expect(shown.mock.calls[0][1].data).toEqual(data)
  })
})
