import { describe, expect, it, vi } from "vitest"
import { checkVideoAvailability } from "./videoAvailability"
import { isYouTubeVideoId, readVideoParam, stripVideoParam } from "./videoDeepLinkParam"

const ID = "dQw4w9WgXcQ"

const respond = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe("checkVideoAvailability: the video's CURRENT status through YouTube's oEmbed, by exact id", () => {
  it("public video, ongoing or upcoming livestream, completed archive and an unlisted video all answer 200: available, with YouTube's title", async () => {
    const fetchImpl = respond(200, { title: "A title" })
    await expect(checkVideoAvailability(ID, { fetchImpl })).resolves.toEqual({ status: "available", title: "A title" })
  })

  it("asks about exactly this video (never a list, never the OshiYobi API), without credentials", async () => {
    const fetchImpl = respond(200, { title: "t" })
    await checkVideoAvailability(ID, { fetchImpl })
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]
    expect(String(url)).toBe(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ID}`)}&format=json`)
    expect(init).toMatchObject({ credentials: "omit" })
  })

  it("an available video without a usable title is still available (title null)", async () => {
    await expect(checkVideoAvailability(ID, { fetchImpl: respond(200, {}) })).resolves.toEqual({ status: "available", title: null })
    const notJson = vi.fn(async () => new Response("not json", { status: 200 })) as unknown as typeof fetch
    await expect(checkVideoAvailability(ID, { fetchImpl: notJson })).resolves.toEqual({ status: "available", title: null })
  })

  it("404 (not found, deleted or private) is unavailable as private/deleted", async () => {
    await expect(checkVideoAvailability(ID, { fetchImpl: respond(404) })).resolves.toEqual({ status: "unavailable", reason: "private_or_deleted" })
  })

  it("401 (exists but cannot be shown) is unavailable WITHOUT claiming a reason", async () => {
    await expect(checkVideoAvailability(ID, { fetchImpl: respond(401) })).resolves.toEqual({ status: "unavailable", reason: "unavailable" })
  })

  it("rate limits, server errors and anything unrecognised are unknown -- never private", async () => {
    for (const status of [403, 429, 500, 502, 503, 400]) {
      await expect(checkVideoAvailability(ID, { fetchImpl: respond(status) }), String(status)).resolves.toEqual({ status: "unknown" })
    }
  })

  it("a network failure is unknown, never private", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch")
    }) as unknown as typeof fetch
    await expect(checkVideoAvailability(ID, { fetchImpl })).resolves.toEqual({ status: "unknown" })
  })

  it("a check that never answers times out as unknown", async () => {
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch
    await expect(checkVideoAvailability(ID, { fetchImpl, timeoutMs: 10 })).resolves.toEqual({ status: "unknown" })
  })

  it("a malformed id is unavailable without any request", async () => {
    const fetchImpl = respond(200)
    await expect(checkVideoAvailability("not-an-id", { fetchImpl })).resolves.toMatchObject({ status: "unavailable" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("the ?video= parameter", () => {
  it("accepts exactly 11 characters of [A-Za-z0-9_-]", () => {
    for (const id of [ID, "a_b-c1234AB", "___________"]) expect(isYouTubeVideoId(id), id).toBe(true)
    for (const id of ["", "short", "twelve_chars!", "dQw4w9WgXc", "dQw4w9WgXcQQ", "dQw4w9WgXc/", "https://x.test", null, undefined, 42]) expect(isYouTubeVideoId(id), String(id)).toBe(false)
  })

  it("reads the raw value, or null when absent", () => {
    expect(readVideoParam(`?video=${ID}`)).toBe(ID)
    expect(readVideoParam("?other=1")).toBeNull()
    expect(readVideoParam("")).toBeNull()
  })

  it("stripVideoParam removes only that parameter, in place: same history length, state, path and other parameters kept", () => {
    window.history.replaceState({ keep: 1 }, "", `/creator/aizawa-ema?video=${ID}&x=1#h`)
    const length = window.history.length
    stripVideoParam()
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/creator/aizawa-ema?x=1#h")
    expect(window.history.state).toEqual({ keep: 1 })
    expect(window.history.length).toBe(length)
  })

  it("stripVideoParam does nothing when there is no video parameter", () => {
    window.history.replaceState({}, "", "/schedule")
    const spy = vi.spyOn(window.history, "replaceState")
    stripVideoParam()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
