import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fetchVideoSearch, type VideoSearchQuery } from "./videoSearch"

vi.stubEnv("VITE_API_BASE_URL", "http://localhost")

/** Cache-identity audit support (Search-session cache follow-up, section 15/24): the backend's Search
 * endpoint also accepts `liveStatus` and `excludeShorts` query parameters (src/api/read_api.py's
 * get_creator_video_search), but this frontend Search path has no UI control for either and never
 * builds a request that includes them -- they are therefore demonstrably FIXED from this path's own
 * perspective (always resolve to the backend's own default), not variables that could make a cached
 * Search-session snapshot stale. This test is the proof: it inspects the actual URL fetchVideoSearch
 * builds and asserts neither parameter is ever present. */
describe("fetchVideoSearch -- request shape", () => {
  const BASE: VideoSearchQuery = { creatorId: "ch_emma", rawQuery: "minecraft", topicIds: [], contentType: "all", sort: "newest", viewWindow: "total" }

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ videos: [], hasMore: false }),
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("never sends excludeShorts or liveStatus -- both are fixed backend defaults for this Search path, not cache-identity variables", async () => {
    await fetchVideoSearch(BASE)
    const [calledUrl] = vi.mocked(fetch).mock.calls[0] as [string]
    const params = new URL(calledUrl, "http://localhost").searchParams
    expect(params.has("excludeShorts")).toBe(false)
    expect(params.has("liveStatus")).toBe(false)
    // The parameters that DO vary and that the cache identity accounts for are present.
    expect(params.get("contentType")).toBe("all")
    expect(params.get("sort")).toBe("newest")
  })

  it("only sends metric (mapped from viewWindow) when sort is mostViews -- never otherwise", async () => {
    await fetchVideoSearch(BASE)
    expect(new URL(vi.mocked(fetch).mock.calls[0][0] as string, "http://localhost").searchParams.has("metric")).toBe(false)

    await fetchVideoSearch({ ...BASE, sort: "mostViews", viewWindow: "7d" })
    const params = new URL(vi.mocked(fetch).mock.calls[1][0] as string, "http://localhost").searchParams
    expect(params.get("metric")).toBe("7d")
  })

  it("omits topicIds entirely when resolution found no topic (not an empty-string parameter)", async () => {
    await fetchVideoSearch(BASE)
    expect(new URL(vi.mocked(fetch).mock.calls[0][0] as string, "http://localhost").searchParams.has("topicIds")).toBe(false)
  })

  it("ALWAYS sends the raw query, and additionally sends comma-separated topicIds when resolution succeeded", () => {
    // This is the hard product rule (section 12/39): a resolved topic is never a substitute for `q`.
    return fetchVideoSearch({ ...BASE, topicIds: ["valorant", "sf6"] }).then(() => {
      const params = new URL(vi.mocked(fetch).mock.calls[0][0] as string, "http://localhost").searchParams
      expect(params.get("q")).toBe("minecraft")
      expect(params.get("topicIds")).toBe("valorant,sf6")
    })
  })
})
