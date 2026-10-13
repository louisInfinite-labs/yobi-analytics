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
