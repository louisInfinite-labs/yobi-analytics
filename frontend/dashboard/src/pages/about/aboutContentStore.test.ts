import { beforeEach, describe, expect, it, vi } from "vitest"
import * as aboutContentApi from "./api/aboutContentApi"
import { aboutContentStore, ensureAboutContentLoaded, retryAboutContentLoad } from "./aboutContentStore"
import { resetAboutContentFetchForTests } from "./aboutContentFetchState"
import type { AboutContent } from "./api/aboutContentApi"

vi.mock("./api/aboutContentApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/aboutContentApi")>()),
  fetchAboutContent: vi.fn(),
}))

function content(version: string): AboutContent {
  return {
    schemaVersion: 1,
    contentVersion: version,
    locales: { en: { pages: [{ id: "about", title: "About", markdown: version }] } },
  }
}

beforeEach(() => {
  resetAboutContentFetchForTests()
  vi.mocked(aboutContentApi.fetchAboutContent).mockReset()
})

describe("aboutContentStore", () => {
  it("a successful fetch populates the store and clears loading/error", async () => {
    vi.mocked(aboutContentApi.fetchAboutContent).mockResolvedValue(content("v1"))

    await ensureAboutContentLoaded()

    expect(aboutContentStore.get()).toEqual({ content: content("v1"), isLoading: false, error: null, failure: null })
  })

  it("ensureAboutContentLoaded only ever fetches once per session", async () => {
    vi.mocked(aboutContentApi.fetchAboutContent).mockResolvedValue(content("v1"))

    await ensureAboutContentLoaded()
    await ensureAboutContentLoaded()
    await ensureAboutContentLoaded()

    expect(aboutContentApi.fetchAboutContent).toHaveBeenCalledTimes(1)
  })

  it("a failed fetch with no prior cache leaves content null and records the error", async () => {
    const failure = new Error("network down")
    vi.mocked(aboutContentApi.fetchAboutContent).mockRejectedValue(failure)

    await ensureAboutContentLoaded()

    expect(aboutContentStore.get()).toEqual({ content: null, isLoading: false, error: "network down", failure })
  })

  it("a retry clears the recorded failure while it is in flight, and a successful retry leaves none", async () => {
    vi.mocked(aboutContentApi.fetchAboutContent).mockRejectedValueOnce(new Error("network down"))
    await ensureAboutContentLoaded()

    let resolve!: (value: AboutContent) => void
    vi.mocked(aboutContentApi.fetchAboutContent).mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const retry = retryAboutContentLoad()
    expect(aboutContentStore.get()).toMatchObject({ isLoading: true, error: null, failure: null })

    resolve(content("v1"))
    await retry
    expect(aboutContentStore.get()).toEqual({ content: content("v1"), isLoading: false, error: null, failure: null })
  })

  it("a later failed retry keeps the last-known-good cached content instead of clearing it", async () => {
    vi.mocked(aboutContentApi.fetchAboutContent).mockResolvedValueOnce(content("v1"))
    await ensureAboutContentLoaded()
    expect(aboutContentStore.get().content).toEqual(content("v1"))

    vi.mocked(aboutContentApi.fetchAboutContent).mockRejectedValueOnce(new Error("timed out"))
    await retryAboutContentLoad()

    const state = aboutContentStore.get()
    expect(state.content).toEqual(content("v1")) // unchanged -- last-known-good preserved
    expect(state.error).toBe("timed out")
    expect(state.isLoading).toBe(false)
  })

  it("a later successful retry replaces the previously cached content", async () => {
    vi.mocked(aboutContentApi.fetchAboutContent).mockResolvedValueOnce(content("v1"))
    await ensureAboutContentLoaded()

    vi.mocked(aboutContentApi.fetchAboutContent).mockResolvedValueOnce(content("v2"))
    await retryAboutContentLoad()

    expect(aboutContentStore.get()).toEqual({ content: content("v2"), isLoading: false, error: null, failure: null })
  })
})
