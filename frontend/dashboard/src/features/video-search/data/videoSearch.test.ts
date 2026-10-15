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
  const BASE: VideoSearchQuery = { creatorId: "ch_emma", rawQuery: "minecraft", terms: [], contentType: "all", sort: "newest", viewWindow: "total" }

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

  it("omits terms entirely when nothing expanded (not an empty-string or empty-array parameter)", async () => {
    await fetchVideoSearch(BASE)
    expect(new URL(vi.mocked(fetch).mock.calls[0][0] as string, "http://localhost").searchParams.has("terms")).toBe(false)
  })

  it("ALWAYS sends the raw query, and additionally sends the expanded title terms as a JSON array", async () => {
    // The hard product rule: expanded terms are never a substitute for `q`.
    await fetchVideoSearch({ ...BASE, rawQuery: "birth", terms: ["birthday", "誕生日", "誕生日配信"] })
    const params = new URL(vi.mocked(fetch).mock.calls[0][0] as string, "http://localhost").searchParams
    expect(params.get("q")).toBe("birth")
    expect(JSON.parse(params.get("terms") as string)).toEqual(["birthday", "誕生日", "誕生日配信"])
  })

  it("keeps a term that contains a comma intact (a JSON array, not a comma-separated list)", async () => {
    await fetchVideoSearch({ ...BASE, terms: ["a,b", "c"] })
    const params = new URL(vi.mocked(fetch).mock.calls[0][0] as string, "http://localhost").searchParams
    expect(JSON.parse(params.get("terms") as string)).toEqual(["a,b", "c"])
  })

  it("never sends a topic id or topicIds: SearchView matches titles only", async () => {
    await fetchVideoSearch({ ...BASE, terms: ["valo"] })
    const params = new URL(vi.mocked(fetch).mock.calls[0][0] as string, "http://localhost").searchParams
    expect(params.has("topicIds")).toBe(false)
    expect(params.has("topic")).toBe(false)
  })
})
