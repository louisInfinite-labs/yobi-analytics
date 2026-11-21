import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "../../../shared/api/apiClient"
import { ABOUT_CONTENT_TIMEOUT_MS, AboutContentFormatError, fetchAboutContent, validateAboutContent } from "./aboutContentApi"

// Deliberately loosely typed (`any`) -- these tests feed intentionally
// malformed/unsupported shapes to the validator, so the fixture itself
// cannot be the well-typed AboutContent shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function minimalPayload(overrides: Record<string, unknown> = {}): any {
  return {
    schemaVersion: 1,
    contentVersion: "1.0",
    locales: {
      "zh-TW": { pages: [{ id: "about", title: "t", markdown: "hi" }] },
      en: { pages: [{ id: "about", title: "t", markdown: "hi" }] },
      ja: { pages: [{ id: "about", title: "t", markdown: "hi" }] },
    },
    ...overrides,
  }
}

describe("validateAboutContent", () => {
  it("accepts a well-formed payload", () => {
    expect(validateAboutContent(minimalPayload())).not.toBeNull()
  })

  it("rejects a non-numeric or missing schemaVersion", () => {
    expect(validateAboutContent(minimalPayload({ schemaVersion: "1" }))).toBeNull()
    expect(validateAboutContent(minimalPayload({ schemaVersion: undefined }))).toBeNull()
  })

  it("rejects any schemaVersion other than the one version this build can render", () => {
    expect(validateAboutContent(minimalPayload({ schemaVersion: 2 }))).toBeNull()
    expect(validateAboutContent(minimalPayload({ schemaVersion: 0 }))).toBeNull()
  })

  it("rejects an empty contentVersion", () => {
    expect(validateAboutContent(minimalPayload({ contentVersion: "" }))).toBeNull()
  })

  it("rejects a non-object payload", () => {
    expect(validateAboutContent(null)).toBeNull()
    expect(validateAboutContent("a string")).toBeNull()
    expect(validateAboutContent(42)).toBeNull()
  })

  it("a page missing markdown is dropped, sibling pages still validate", () => {
    const payload = minimalPayload()
    payload.locales.en.pages.push({ id: "broken", title: "Broken" })
    payload.locales.en.pages.push({ id: "about2", title: "ok", markdown: "more text" })
    const validated = validateAboutContent(payload)
    expect(validated?.locales.en.pages.map((p) => p.id)).toEqual(["about", "about2"])
  })

  it("a page with empty markdown is dropped", () => {
    const payload = minimalPayload()
    payload.locales.en.pages = [{ id: "about", title: "t", markdown: "" }]
    const validated = validateAboutContent(payload)
    expect(validated?.locales.en).toBeUndefined()
  })

  it("an unknown extra field on a page is ignored, not fatal", () => {
    const payload = minimalPayload()
    payload.locales.en.pages[0].futureField = { anything: true }
    const validated = validateAboutContent(payload)
    expect(validated?.locales.en.pages[0]).toEqual({ id: "about", title: "t", markdown: "hi" })
  })

  it("returns a payload missing a locale entirely when that locale is unusable, others survive", () => {
    const payload = minimalPayload()
    payload.locales.en.pages = [{ id: "broken" }]
    const validated = validateAboutContent(payload)
    // "en" is dropped entirely, but zh-TW/ja are still usable -- the whole
    // payload is still valid as long as at least one locale survives.
    expect(validated?.locales.en).toBeUndefined()
    expect(validated?.locales["zh-TW"]).toBeDefined()
  })

  it("returns null when every locale is unusable", () => {
    const payload = minimalPayload({ locales: { en: { pages: [] } } })
    expect(validateAboutContent(payload)).toBeNull()
  })

  it("returns null when locales is missing or not an object", () => {
    expect(validateAboutContent(minimalPayload({ locales: undefined }))).toBeNull()
    expect(validateAboutContent(minimalPayload({ locales: "not-an-object" }))).toBeNull()
  })
})

// fetch is always stubbed here: no test in this file can reach a real API, whatever VITE_API_BASE_URL the environment carries.
describe("fetchAboutContent", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.test")
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

  it("returns the validated content of a successful response", async () => {
    fetchMock.mockResolvedValue(json(200, minimalPayload()))
    await expect(fetchAboutContent()).resolves.toMatchObject({ schemaVersion: 1, contentVersion: "1.0" })
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.test/about-content")
  })

  it("passes an HTTP error through as the ApiError it is (status kept for the page to describe)", async () => {
    fetchMock.mockResolvedValue(json(404, { error: "Not Found" }))
    await expect(fetchAboutContent()).rejects.toMatchObject({ status: 404 })
    fetchMock.mockResolvedValue(json(500, { error: "Internal Server Error" }))
    await expect(fetchAboutContent()).rejects.toBeInstanceOf(ApiError)
  })

  it("rejects a 2xx response it cannot render with AboutContentFormatError (an answered request, not a network failure)", async () => {
    fetchMock.mockResolvedValue(json(200, minimalPayload({ schemaVersion: 2 })))
    await expect(fetchAboutContent()).rejects.toBeInstanceOf(AboutContentFormatError)
    fetchMock.mockResolvedValue(json(200, { unexpected: true }))
    await expect(fetchAboutContent()).rejects.toBeInstanceOf(AboutContentFormatError)
  })

  it("passes a network failure through unchanged", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))
    await expect(fetchAboutContent()).rejects.not.toBeInstanceOf(AboutContentFormatError)
  })

  it("passes a network failure through with its own message", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))
    await expect(fetchAboutContent()).rejects.toThrow("Failed to fetch")
  })

  it("aborts a request that has not answered within the timeout and rejects with a plain (non-HTTP) Error", async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")))
        }),
    )
    const pending = fetchAboutContent()
    const assertion = expect(pending).rejects.toThrow("The About content request timed out")
    await vi.advanceTimersByTimeAsync(ABOUT_CONTENT_TIMEOUT_MS)
    await assertion
    await expect(pending).rejects.not.toBeInstanceOf(ApiError)
  })

  it("does not abort a request that answers in time", async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(json(200, minimalPayload()))
    await expect(fetchAboutContent()).resolves.toMatchObject({ schemaVersion: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })
})
