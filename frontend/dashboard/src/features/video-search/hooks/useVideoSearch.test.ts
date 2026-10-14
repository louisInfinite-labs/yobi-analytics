import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useVideoSearch, type VideoSearchBase } from "./useVideoSearch"
import { fetchVideoSearch, type VideoSearchResult } from "../data/videoSearch"
import type { BackendVideoTopic } from "../../home-room/model/videoTopicCatalog"

vi.mock("../data/videoSearch", () => ({ fetchVideoSearch: vi.fn() }))
vi.stubEnv("VITE_API_BASE_URL", "")

const BASE: VideoSearchBase = { creatorId: "ch_emma", contentType: "all", sort: "newest", viewWindow: "total" }

function searchResult(videoId: string, title = "t", topic: string | null = null): VideoSearchResult {
  return { videoId, title, publishedAt: "2026-01-01T00:00:00Z", contentFormat: "normal_video", topic }
}

/** Resolves fetchVideoSearch deterministically by the query actually sent -- `responses` maps a raw
 * query string to the (ALWAYS complete -- this endpoint has no pagination) backend result for it, so
 * test sequences can assert request COUNTS precisely instead of just "was called". */
function mockBackend(responses: Record<string, VideoSearchResult[]>) {
  vi.mocked(fetchVideoSearch).mockImplementation(async (query) => responses[query.rawQuery] ?? [])
}

beforeEach(() => {
  vi.mocked(fetchVideoSearch).mockReset()
  mockBackend({})
  vi.useFakeTimers()
})

async function settle(ms = 300) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
    await Promise.resolve()
    await Promise.resolve()
  })
}

function requestCount() {
  return vi.mocked(fetchVideoSearch).mock.calls.length
}

describe("useVideoSearch -- activation threshold gates the request, never the UI alone", () => {
  it("is inactive and issues no request below the activation threshold", async () => {
    const { result } = renderHook(() => useVideoSearch("ab", BASE))
    await settle(500)
    expect(result.current.active).toBe(false)
    expect(result.current.videos).toEqual([])
    expect(fetchVideoSearch).not.toHaveBeenCalled()
  })

  it("activates and issues a debounced request once the threshold is met", async () => {
    const { result } = renderHook(() => useVideoSearch("abc", BASE))
    expect(result.current.active).toBe(true)
    expect(fetchVideoSearch).not.toHaveBeenCalled() // not yet -- still debouncing
    await settle()
    expect(fetchVideoSearch).toHaveBeenCalledTimes(1)
    expect(fetchVideoSearch).toHaveBeenCalledWith(expect.objectContaining({ rawQuery: "abc", creatorId: "ch_emma" }), expect.anything())
  })

  it("one Han character activates immediately (no 3-character minimum)", () => {
    const { result } = renderHook(() => useVideoSearch("魔", BASE))
    expect(result.current.active).toBe(true)
  })

  it("does not call the backend on every keystroke -- only after the debounce settles", async () => {
    const { result, rerender } = renderHook(({ q }) => useVideoSearch(q, BASE), { initialProps: { q: "abc" } })
    rerender({ q: "abcd" })
    rerender({ q: "abcde" })
    await settle()
    expect(fetchVideoSearch).toHaveBeenCalledTimes(1)
    expect(fetchVideoSearch).toHaveBeenCalledWith(expect.objectContaining({ rawQuery: "abcde" }), expect.anything())
    expect(result.current.active).toBe(true)
  })

  it("falling back below the threshold clears any results and stops being active", async () => {
    mockBackend({ abc: [searchResult("v1")] })
    const { result, rerender } = renderHook(({ q }) => useVideoSearch(q, BASE), { initialProps: { q: "abc" } })
    await settle()
    expect(result.current.videos).toHaveLength(1)

    rerender({ q: "a" })
    expect(result.current.active).toBe(false)
    expect(result.current.videos).toEqual([])
  })

  it("does not request at all when there is no creator (base is null)", async () => {
    renderHook(() => useVideoSearch("abc", null))
    await settle(500)
    expect(fetchVideoSearch).not.toHaveBeenCalled()
  })

  it("an empty query never sends a backend request, even though it is reachable from an active query", async () => {
    mockBackend({ bir: [searchResult("v1")] })
    const { rerender } = renderHook(({ q }) => useVideoSearch(q, BASE), { initialProps: { q: "bir" } })
    await settle()
    expect(requestCount()).toBe(1)
    rerender({ q: "" })
    await settle(500)
    expect(requestCount()).toBe(1) // still 1 -- clearing to "" must never itself call the backend
  })
})

describe("useVideoSearch -- stale response protection", () => {
  it("a slower, earlier request's response never overwrites a later (non-derivable) query's results", async () => {
    let resolveFirst!: (value: VideoSearchResult[]) => void
    vi.mocked(fetchVideoSearch)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce([searchResult("second")])

    const { result, rerender } = renderHook(({ q }) => useVideoSearch(q, BASE), { initialProps: { q: "first" } })
    await settle()
    rerender({ q: "second" }) // "second" is not an extension of "first" -- a fresh backend request is required
    await settle()
    expect(result.current.videos.map((v) => v.videoId)).toEqual(["second"])

    resolveFirst([])
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.videos.map((v) => v.videoId)).toEqual(["second"])
  })
})

describe("useVideoSearch -- Search-session cache: required request-count scenarios", () => {
  it("CASE 1: b -> bi -> bir -> birt -> birth -> birthd -> birthda -> birthday issues exactly ONE backend request", async () => {
    mockBackend({ bir: [searchResult("v1", "Birthday Special Stream")] })
    const { rerender } = renderHook(({ q }) => useVideoSearch(q, BASE), { initialProps: { q: "b" } })
    rerender({ q: "bi" }) // still below threshold
    rerender({ q: "bir" }) // threshold reached
    await settle() // Backend #1
    expect(requestCount()).toBe(1)

    for (const q of ["birt", "birth", "birthd", "birthda", "birthday"]) {
      rerender({ q })
      await act(async () => {}) // let effects flush -- no timer to advance, resolution is immediate
    }
    expect(requestCount()).toBe(1) // local narrowing the whole way -- every prefix of "birthday special..." matches
  })

  it("CASE 2: bir -> birthday -> bird -> bir derives everything locally after one request, and restores the ORIGINAL complete snapshot (not a reconstruction)", async () => {
    mockBackend({ bir: [searchResult("v1", "Birthday Special Stream")] })
    const { result, rerender } = renderHook(({ q }) => useVideoSearch(q, BASE), { initialProps: { q: "bir" } })
    await settle()
    expect(requestCount()).toBe(1)
    expect(result.current.videos).toHaveLength(1)

    rerender({ q: "birthday" })
    await act(async () => {})
    expect(result.current.videos).toHaveLength(1) // "birthday" IS a substring of the cached title

    rerender({ q: "bird" }) // a typo relative to the actual title -- zero visible matches, but still LOCAL
    await act(async () => {})
    expect(requestCount()).toBe(1)
    expect(result.current.videos).toHaveLength(0)

    rerender({ q: "bir" }) // back to the exact cached base
    await act(async () => {})
    expect(requestCount()).toBe(1)
    expect(result.current.videos).toHaveLength(1) // the original snapshot, restored -- not derived from the zero-result view
  })

  it("CASE 3: bir -> bi -> bir issues exactly ONE backend request total", async () => {
    mockBackend({ bir: [searchResult("v1")] })
    const { result, rerender } = renderHook(({ q }) => useVideoSearch(q, BASE), { initialProps: { q: "bir" } })
    await settle()
    expect(requestCount()).toBe(1)

    rerender({ q: "bi" }) // below threshold -- Search exits, cache is kept (not cleared)
    expect(result.current.active).toBe(false)

    rerender({ q: "bir" }) // exact cache hit -- no debounce wait needed
    await act(async () => {})
    expect(requestCount()).toBe(1)
    expect(result.current.active).toBe(true)
    expect(result.current.videos).toHaveLength(1)
  })

  it("CASE 4: bir -> \"\" -> bir issues TWO backend requests total (the empty query destroys the cache)", async () => {
    mockBackend({ bir: [searchResult("v1")] })
    const { rerender } = renderHook(({ q }) => useVideoSearch(q, BASE), { initialProps: { q: "bir" } })
    await settle()
    expect(requestCount()).toBe(1)

    rerender({ q: "" })
    await settle(500)
    expect(requestCount()).toBe(1) // clearing itself never requests

    rerender({ q: "bir" })
    await settle() // a fresh debounce + request -- the session was fully reset
    expect(requestCount()).toBe(2)
  })

  it("CASE 5: bir -> bit -> bir issues TWO backend requests total (bit cannot be derived from bir; bir is still cached)", async () => {
    mockBackend({ bir: [searchResult("v1")], bit: [searchResult("v2")] })
    const { result, rerender } = renderHook(({ q }) => useVideoSearch(q, BASE), { initialProps: { q: "bir" } })
    await settle()
    expect(requestCount()).toBe(1)

    rerender({ q: "bit" })
    await settle() // "bit" is not an extension of "bir" -- requires its own request
    expect(requestCount()).toBe(2)
    expect(result.current.videos.map((v) => v.videoId)).toEqual(["v2"])

    rerender({ q: "bir" })
    await act(async () => {}) // the original "bir" snapshot is still in the bounded cache
    expect(requestCount()).toBe(2)
    expect(result.current.videos.map((v) => v.videoId)).toEqual(["v1"])
  })

  it("CASE 6: 'street fighter' -> 'street' issues TWO backend requests total (street is BROADER than the cached base)", async () => {
    mockBackend({
      "street fighter": [searchResult("v1", "Street Fighter 6 ranked")],
      street: [searchResult("v1", "Street Fighter 6 ranked"), searchResult("v2", "Sesame Street clip")],
    })
    // Typed quickly: no earlier debounce ever fires for a shorter prefix.
    const { result, rerender } = renderHook(({ q }) => useVideoSearch(q, BASE), { initialProps: { q: "street fighter" } })
    await settle()
    expect(requestCount()).toBe(1)

    rerender({ q: "street" }) // a prefix OF the cached base -- the reverse (broadening) relationship
    await settle()
    expect(requestCount()).toBe(2)
    expect(result.current.videos.map((v) => v.videoId)).toEqual(["v1", "v2"])
  })
})

describe("useVideoSearch -- every successful response is a complete result set (no pagination on this endpoint)", () => {
  it("a result set far larger than the old 100-item page size still arrives in one response and is fully cacheable", async () => {
    const manyVideos = Array.from({ length: 250 }, (_, i) => searchResult(`v${i}`, "Minecraft stream"))
    mockBackend({ minecraft: manyVideos })
    const { result, rerender } = renderHook(({ q }) => useVideoSearch(q, BASE), { initialProps: { q: "minecraft" } })
    await settle()
    expect(requestCount()).toBe(1)
    expect(result.current.videos).toHaveLength(250)

    // A true extension of "minecraft" narrows locally over all 250 -- zero additional requests, and the
    // narrowed count proves the full 250 (not a truncated page of them) was actually cached.
    rerender({ q: "minecraft stream" })
    await act(async () => {})
    expect(requestCount()).toBe(1)
    expect(result.current.videos).toHaveLength(250)
  })

  it("has no loadMore or hasMore in its returned state -- there is nothing further to page through", async () => {
    mockBackend({ bir: [searchResult("v1")] })
    const { result, rerender } = renderHook(({ q }) => useVideoSearch(q, BASE), { initialProps: { q: "bir" } })
    await settle()
    expect("loadMore" in result.current).toBe(false)
    expect("hasMore" in result.current).toBe(false)
    rerender({ q: "bir" })
  })
})

describe("useVideoSearch -- final architecture: frontend resolves topic ids locally, never a frontend taxonomy or backend-resolved evidence", () => {
  // FIXTURE-ONLY topic -- "birthday" is not a real backend topic id (tracking.video_topics.TOPICS has no
  // such entry); used purely to exercise the generic resolve-locally/union/narrow mechanism end to end.
  const FIXTURE_TOPICS: BackendVideoTopic[] = [{ id: "birthday", labels: { en: "Birthday" }, searchAliases: ["birth", "birthday"] }]

  it("resolves topicIds locally against the caller-supplied catalog and sends them ALONGSIDE the raw query on the very first request", async () => {
    mockBackend({ bir: [searchResult("v1", "誕生日配信", "birthday")] })
    renderHook(() => useVideoSearch("bir", BASE, { topics: FIXTURE_TOPICS }))
    await settle()
    // "bir" is a prefix of the fixture alias "birth" -- resolves ["birthday"] -- and `rawQuery` is still sent.
    expect(fetchVideoSearch).toHaveBeenCalledWith(expect.objectContaining({ rawQuery: "bir", topicIds: ["birthday"] }), expect.anything())
  })

  it("still sends the raw query even when local resolution finds no topic -- topicIds is never a substitute for it", async () => {
    mockBackend({ "funny moment": [searchResult("v1", "funny moment compilation")] })
    renderHook(() => useVideoSearch("funny moment", BASE, { topics: FIXTURE_TOPICS }))
    await settle()
    expect(fetchVideoSearch).toHaveBeenCalledWith(expect.objectContaining({ rawQuery: "funny moment", topicIds: [] }), expect.anything())
  })

  it("keeps a Japanese-titled result across a narrowing extension via its topic + the downloaded catalog, with zero extra requests", async () => {
    mockBackend({ bir: [searchResult("v1", "誕生日配信", "birthday")] })
    const { result, rerender } = renderHook(({ q }) => useVideoSearch(q, BASE, { topics: FIXTURE_TOPICS }), { initialProps: { q: "bir" } })
    await settle()
    expect(requestCount()).toBe(1)
    expect(result.current.videos).toHaveLength(1)

    rerender({ q: "birth" }) // the title itself does NOT contain "birth" -- only topic+catalog resolution does
    await act(async () => {})
    expect(requestCount()).toBe(1)
    expect(result.current.videos).toHaveLength(1)

    rerender({ q: "birthday" })
    await act(async () => {})
    expect(requestCount()).toBe(1)
    expect(result.current.videos).toHaveLength(1)
  })

  it("drops the topic-matched video once the query extends past every searchable form of its topic -- zero extra requests either way", async () => {
    mockBackend({ bir: [searchResult("v1", "誕生日配信", "birthday")] })
    const { result, rerender } = renderHook(({ q }) => useVideoSearch(q, BASE, { topics: FIXTURE_TOPICS }), { initialProps: { q: "bir" } })
    await settle()
    rerender({ q: "birthdayx" })
    await act(async () => {})
    expect(requestCount()).toBe(1)
    expect(result.current.videos).toHaveLength(0)
  })
})

describe("useVideoSearch -- Filter/Sort is part of cache identity", () => {
  it("does not reuse a snapshot across a Filter/Sort change -- one new request when no matching-identity snapshot exists", async () => {
    mockBackend({
      bir: [searchResult("v1", "birthday stream")],
      birth: [searchResult("v1", "birthday stream")],
    })
    const { result, rerender } = renderHook(({ q, base }) => useVideoSearch(q, base), { initialProps: { q: "bir", base: BASE } })
    await settle()
    expect(requestCount()).toBe(1)

    rerender({ q: "birth", base: BASE }) // still the same identity -- locally derivable
    await act(async () => {})
    expect(requestCount()).toBe(1)

    const mostViewsBase: VideoSearchBase = { ...BASE, sort: "mostViews" }
    rerender({ q: "birth", base: mostViewsBase }) // sort changed -- the "newest" snapshot must not be reused as-is
    await settle()
    expect(requestCount()).toBe(2)
    expect(result.current.videos.map((v) => v.videoId)).toEqual(["v1"])
  })

  it("never reuses a snapshot across a different creator", async () => {
    mockBackend({ bir: [searchResult("v1")] })
    const { rerender } = renderHook(({ q, base }) => useVideoSearch(q, base), { initialProps: { q: "bir", base: BASE } })
    await settle()
    expect(requestCount()).toBe(1)

    rerender({ q: "bir", base: { ...BASE, creatorId: "ch_other" } })
    await settle()
    expect(requestCount()).toBe(2)
  })
})

describe("useVideoSearch -- IME composition", () => {
  it("does not schedule a backend request while composing, even past the debounce window", async () => {
    const { rerender } = renderHook(({ q, composing }) => useVideoSearch(q, BASE, { isComposing: composing }), {
      initialProps: { q: "もん", composing: true },
    })
    await settle(500)
    expect(fetchVideoSearch).not.toHaveBeenCalled()

    rerender({ q: "もんはん", composing: true })
    await settle(500)
    expect(fetchVideoSearch).not.toHaveBeenCalled()
  })

  it("evaluates the final composed text once composition ends", async () => {
    mockBackend({ もんはん: [searchResult("v1")] })
    const { rerender } = renderHook(({ q, composing }) => useVideoSearch(q, BASE, { isComposing: composing }), {
      initialProps: { q: "もんはん", composing: true },
    })
    await settle(500)
    expect(fetchVideoSearch).not.toHaveBeenCalled()

    rerender({ q: "もんはん", composing: false }) // compositionend with the final text
    await settle()
    expect(requestCount()).toBe(1)
  })
})

describe("useVideoSearch -- flush (Enter)", () => {
  it("fires a pending debounced request immediately instead of waiting out the rest of the window", async () => {
    mockBackend({ abc: [searchResult("v1")] })
    const { result } = renderHook(() => useVideoSearch("abc", BASE))
    expect(fetchVideoSearch).not.toHaveBeenCalled()
    await act(async () => {
      result.current.flush()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(requestCount()).toBe(1) // fired well before SEARCH_DEBOUNCE_MS elapsed
  })

  it("is a no-op when the query is already resolved locally -- never forces a redundant request", async () => {
    mockBackend({ bir: [searchResult("v1", "birthday stream")] })
    const { result, rerender } = renderHook(({ q }) => useVideoSearch(q, BASE), { initialProps: { q: "bir" } })
    await settle()
    expect(requestCount()).toBe(1)

    rerender({ q: "birth" }) // resolved locally, no pending timer
    await act(async () => {})
    act(() => result.current.flush())
    expect(requestCount()).toBe(1)
  })

  it("is a no-op while composing", async () => {
    const { result } = renderHook(() => useVideoSearch("abc", BASE, { isComposing: true }))
    act(() => result.current.flush())
    await settle(500)
    expect(fetchVideoSearch).not.toHaveBeenCalled()
  })
})
