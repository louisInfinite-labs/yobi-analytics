import { describe, expect, it } from "vitest"
import { SearchSessionCache, deriveVisibleResults, type SearchCacheIdentity } from "./searchSessionCache"
import type { VideoSearchResult } from "../data/videoSearch"

const IDENTITY: SearchCacheIdentity = { creatorId: "ch_emma", contentType: "all", sort: "newest", viewWindow: "total" }

function video(videoId: string, title: string, topic: string | null = null): VideoSearchResult {
  return { videoId, title, publishedAt: "2026-01-01T00:00:00Z", contentFormat: "normal_video", topic }
}

describe("SearchSessionCache -- exact and longest-prefix reuse", () => {
  it("returns null when nothing is cached", () => {
    const cache = new SearchSessionCache()
    expect(cache.findReusableBase(IDENTITY, "bir")).toBeNull()
  })

  it("returns an exact match for an identical normalized query", () => {
    const cache = new SearchSessionCache()
    const videos = [video("v1", "birthday stream")]
    cache.store(IDENTITY, "bir", videos)
    const found = cache.findReusableBase(IDENTITY, "bir")
    expect(found?.baseQuery).toBe("bir")
    expect(found?.videos).toBe(videos) // the exact snapshot object, not a filtered copy
  })

  it("prefers the LONGEST cached base that is a true prefix of the current query", () => {
    const cache = new SearchSessionCache()
    cache.store(IDENTITY, "bir", [video("v1", "birthday")])
    cache.store(IDENTITY, "birth", [video("v1", "birthday")])
    const found = cache.findReusableBase(IDENTITY, "birthday")
    expect(found?.baseQuery).toBe("birth")
  })

  it("does not reuse a cached base that is not a true prefix (a sibling branch)", () => {
    const cache = new SearchSessionCache()
    cache.store(IDENTITY, "bir", [video("v1", "birthday")])
    expect(cache.findReusableBase(IDENTITY, "bit")).toBeNull()
  })

  it("does not reuse a cached base that is BROADER than the current query (the reverse relationship)", () => {
    const cache = new SearchSessionCache()
    cache.store(IDENTITY, "street fighter", [video("v1", "street fighter 6")])
    // "street" is a prefix OF "street fighter", not the other way around -- "street fighter".startsWith("street")
    // being true does NOT make the cached "street fighter" base reusable for the broader "street" query.
    expect(cache.findReusableBase(IDENTITY, "street")).toBeNull()
  })

  it("never treats a cached empty-string base as reusable", () => {
    const cache = new SearchSessionCache()
    cache.store(IDENTITY, "", [video("v1", "anything")])
    expect(cache.findReusableBase(IDENTITY, "bir")).toBeNull()
  })
})

describe("SearchSessionCache -- a snapshot is only a complete base for queries whose terms it was fetched with", () => {
  it("is reusable when every term of the new query was part of the fetch", () => {
    const cache = new SearchSessionCache()
    cache.store(IDENTITY, "bir", [video("v1", "誕生日")], ["birthday", "誕生日"])
    expect(cache.findReusableBase(IDENTITY, "birth", ["birthday"])?.baseQuery).toBe("bir")
    expect(cache.findReusableBase(IDENTITY, "bir", ["birthday", "誕生日"])?.baseQuery).toBe("bir") // exact, same terms
  })

  it("is NOT reusable when the new query needs a term the snapshot was not fetched with (e.g. the catalog loaded later)", () => {
    const cache = new SearchSessionCache()
    cache.store(IDENTITY, "bir", [video("v1", "birthday stream")], []) // fetched before GET /topics had loaded: no expansion
    expect(cache.findReusableBase(IDENTITY, "birth", ["birthday", "誕生日"])).toBeNull() // a longer query that now expands would miss rows
    expect(cache.findReusableBase(IDENTITY, "bir", ["birthday"])).toBeNull() // even the exact query, now that it expands
    expect(cache.findReusableBase(IDENTITY, "birth", [])?.baseQuery).toBe("bir") // no extra terms needed: still safe
  })

  it("falls back to another covering snapshot when the longest prefix does not cover the terms", () => {
    const cache = new SearchSessionCache()
    cache.store(IDENTITY, "bi", [video("v1", "x")], ["birthday", "誕生日"])
    cache.store(IDENTITY, "bir", [video("v1", "x")], []) // longer, but fetched without terms
    expect(cache.findReusableBase(IDENTITY, "birth", ["birthday"])?.baseQuery).toBe("bi")
  })
})

describe("SearchSessionCache -- identity isolation", () => {
  it("never reuses a snapshot across a different creator/Filter/Sort identity", () => {
    const cache = new SearchSessionCache()
    cache.store(IDENTITY, "bir", [video("v1", "birthday")])
    const otherCreator: SearchCacheIdentity = { ...IDENTITY, creatorId: "ch_other" }
    expect(cache.findReusableBase(otherCreator, "bir")).toBeNull()
    const otherSort: SearchCacheIdentity = { ...IDENTITY, sort: "mostViews" }
    expect(cache.findReusableBase(otherSort, "bir")).toBeNull()
  })

  it("clears every snapshot when the identity changes (a store() under a new identity wipes the old one)", () => {
    const cache = new SearchSessionCache()
    cache.store(IDENTITY, "bir", [video("v1", "birthday")])
    const otherSort: SearchCacheIdentity = { ...IDENTITY, sort: "mostViews" }
    cache.store(otherSort, "bir", [video("v2", "birthday")])
    expect(cache.findReusableBase(IDENTITY, "bir")).toBeNull()
    expect(cache.findReusableBase(otherSort, "bir")?.videos[0].videoId).toBe("v2")
  })
})

describe("SearchSessionCache -- eviction and reset", () => {
  it("evicts the least-recently-used snapshot once the bound is exceeded", () => {
    const cache = new SearchSessionCache()
    for (let i = 0; i < 9; i++) cache.store(IDENTITY, `q${i}`, [video(`v${i}`, "t")])
    expect(cache.findReusableBase(IDENTITY, "q0")).toBeNull() // evicted (oldest, 9 stores > bound of 8)
    expect(cache.findReusableBase(IDENTITY, "q8")).not.toBeNull()
  })

  it("touching (reusing) a snapshot protects it from eviction ahead of less-recently-used ones", () => {
    const cache = new SearchSessionCache()
    for (let i = 0; i < 8; i++) cache.store(IDENTITY, `q${i}`, [video(`v${i}`, "t")])
    cache.findReusableBase(IDENTITY, "q0") // touch -- now most-recently-used
    cache.store(IDENTITY, "q8", [video("v8", "t")]) // exceeds bound; least-recently-used (q1) evicted, not q0
    expect(cache.findReusableBase(IDENTITY, "q0")).not.toBeNull()
    expect(cache.findReusableBase(IDENTITY, "q1")).toBeNull()
  })

  it("clear() removes every snapshot", () => {
    const cache = new SearchSessionCache()
    cache.store(IDENTITY, "bir", [video("v1", "birthday")])
    cache.clear()
    expect(cache.findReusableBase(IDENTITY, "bir")).toBeNull()
  })
})

describe("deriveVisibleResults", () => {
  it("returns every video for an exact base-query match, in the original order", () => {
    const videos = [video("v1", "a"), video("v2", "b")]
    const snapshot = { baseQuery: "bir", videos, terms: [] }
    expect(deriveVisibleResults(snapshot, "bir", []).map((v) => v.videoId)).toEqual(["v1", "v2"])
  })

  it("narrows by direct title substring using the SAME normalization as the backend", () => {
    const videos = [video("v1", "Birthday Stream"), video("v2", "unrelated title")]
    const snapshot = { baseQuery: "bir", videos, terms: [] }
    expect(deriveVisibleResults(snapshot, "birthday", []).map((v) => v.videoId)).toEqual(["v1"])
  })

  it("keeps a video whose title does not contain the longer query when it contains one of the query's expanded terms", () => {
    // "birth" expands to the Japanese term 誕生日, which this title contains even though it does not contain "birth".
    const videos = [video("v1", "誕生日配信")]
    const snapshot = { baseQuery: "bir", videos, terms: ["birthday", "誕生日"] }
    expect(deriveVisibleResults(snapshot, "birth", ["birthday", "誕生日"]).map((v) => v.videoId)).toEqual(["v1"])
    expect(deriveVisibleResults(snapshot, "birthday", ["birthday", "誕生日"]).map((v) => v.videoId)).toEqual(["v1"])
  })

  it("drops a video once the query extends past every term (nothing in its title matches any more)", () => {
    const videos = [video("v1", "誕生日配信")]
    const snapshot = { baseQuery: "bir", videos, terms: ["birthday", "誕生日"] }
    expect(deriveVisibleResults(snapshot, "birthdayx", [])).toEqual([])
  })

  it("NEVER keeps a video because of its persisted topic: only titles decide", () => {
    const videos = [video("v1", "全く関係ないタイトル", "誕生日"), video("v2", "誕生日の話", null)]
    const snapshot = { baseQuery: "bir", videos, terms: ["birthday", "誕生日"] }
    expect(deriveVisibleResults(snapshot, "birth", ["birthday", "誕生日"]).map((v) => v.videoId)).toEqual(["v2"])
  })

  it("with no terms passed, only the query itself can match a title (never a second network fetch or catalog read)", () => {
    const videos = [video("v1", "誕生日配信")]
    expect(deriveVisibleResults({ baseQuery: "bir", videos, terms: [] }, "birth", [])).toEqual([])
  })

  it("matches normalized titles: full-width and case differences do not hide a match", () => {
    const videos = [video("v1", "ＢＩＲＴＨＤＡＹ Ｓｔｒｅａｍ")]
    expect(deriveVisibleResults({ baseQuery: "bir", videos, terms: [] }, "birthday", []).map((v) => v.videoId)).toEqual(["v1"])
  })

  it("always derives from the ORIGINAL complete snapshot, never by further-filtering a previously narrowed view", () => {
    const videos = [video("v1", "Monster Hunter stream"), video("v2", "Monument tour")]
    const snapshot = { baseQuery: "mon", videos, terms: [] } // both genuinely matched the base query "mon"
    const narrowed = deriveVisibleResults(snapshot, "monst", [])
    expect(narrowed.map((v) => v.videoId)).toEqual(["v1"]) // "Monument" has no "monst" substring -- v2 drops out
    // Backspacing from "monst" to "mon" must restore v2 too. If this were derived by filtering `narrowed`
    // instead of the original `snapshot.videos`, v2 could never reappear (it was already excluded there).
    const restored = deriveVisibleResults(snapshot, "mon", [])
    expect(restored.map((v) => v.videoId)).toEqual(["v1", "v2"])
  })

  it("preserves the snapshot's own relative order when narrowing (no relevance re-ranking)", () => {
    const videos = [video("v3", "birthday c"), video("v1", "birthday a"), video("v2", "birthday b")]
    const snapshot = { baseQuery: "bir", videos, terms: [] }
    expect(deriveVisibleResults(snapshot, "birthday", []).map((v) => v.videoId)).toEqual(["v3", "v1", "v2"])
  })

  it("never mutates the snapshot's own videos array", () => {
    const videos = [video("v1", "birthday")]
    const snapshot = { baseQuery: "bir", videos, terms: [] }
    deriveVisibleResults(snapshot, "birthday", [])
    expect(snapshot.videos).toBe(videos)
    expect(snapshot.videos).toHaveLength(1)
  })
})
