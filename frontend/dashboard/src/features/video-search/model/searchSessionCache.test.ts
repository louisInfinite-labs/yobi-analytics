import { describe, expect, it } from "vitest"
import { SearchSessionCache, deriveVisibleResults, type SearchCacheIdentity } from "./searchSessionCache"
import type { VideoSearchResult } from "../data/videoSearch"
import type { BackendVideoTopic } from "../../home-room/model/videoTopicCatalog"

const IDENTITY: SearchCacheIdentity = { creatorId: "ch_emma", contentType: "all", sort: "newest", viewWindow: "total" }

/** FIXTURE-ONLY topic catalog: "birthday" is not a real backend topic (tracking.video_topics.TOPICS has
 * no such id) -- used purely to exercise the generic local-narrowing mechanism against a topic whose
 * title text does not itself contain the query, mirroring the shape a real multilingual topic (e.g.
 * valorant/"VALO") would have. */
const FIXTURE_TOPICS: BackendVideoTopic[] = [{ id: "birthday", labels: { en: "Birthday" }, searchAliases: ["birth", "birthday"] }]

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
    const snapshot = { baseQuery: "bir", videos }
    expect(deriveVisibleResults(snapshot, "bir", []).map((v) => v.videoId)).toEqual(["v1", "v2"])
  })

  it("narrows by direct title substring using the SAME normalization as the backend", () => {
    const videos = [video("v1", "Birthday Stream"), video("v2", "unrelated title")]
    const snapshot = { baseQuery: "bir", videos }
    expect(deriveVisibleResults(snapshot, "birthday", []).map((v) => v.videoId)).toEqual(["v1"])
  })

  it("keeps a video whose title does NOT contain the longer query, via its topic + the downloaded topic catalog", () => {
    // Japanese-titled video that matched the base query "bir" only via its FIXTURE-ONLY topic's alias.
    const videos = [video("v1", "誕生日配信", "birthday")]
    const snapshot = { baseQuery: "bir", videos }
    expect(deriveVisibleResults(snapshot, "birth", FIXTURE_TOPICS).map((v) => v.videoId)).toEqual(["v1"])
    expect(deriveVisibleResults(snapshot, "birthday", FIXTURE_TOPICS).map((v) => v.videoId)).toEqual(["v1"])
  })

  it("drops a topic-matched video once the query extends past every searchable form of its topic", () => {
    const videos = [video("v1", "誕生日配信", "birthday")]
    const snapshot = { baseQuery: "bir", videos }
    expect(deriveVisibleResults(snapshot, "birthdayx", FIXTURE_TOPICS)).toEqual([])
  })

  it("a topic-matched video never resolves without the topic catalog being passed in (never a second network fetch)", () => {
    const videos = [video("v1", "誕生日配信", "birthday")]
    const snapshot = { baseQuery: "bir", videos }
    expect(deriveVisibleResults(snapshot, "birth", [])).toEqual([]) // empty catalog -- title alone can't match either
  })

  it("always derives from the ORIGINAL complete snapshot, never by further-filtering a previously narrowed view", () => {
    const videos = [video("v1", "Monster Hunter stream"), video("v2", "Monument tour")]
    const snapshot = { baseQuery: "mon", videos } // both genuinely matched the base query "mon"
    const narrowed = deriveVisibleResults(snapshot, "monst", [])
    expect(narrowed.map((v) => v.videoId)).toEqual(["v1"]) // "Monument" has no "monst" substring -- v2 drops out
    // Backspacing from "monst" to "mon" must restore v2 too. If this were derived by filtering `narrowed`
    // instead of the original `snapshot.videos`, v2 could never reappear (it was already excluded there).
    const restored = deriveVisibleResults(snapshot, "mon", [])
    expect(restored.map((v) => v.videoId)).toEqual(["v1", "v2"])
  })

  it("preserves the snapshot's own relative order when narrowing (no relevance re-ranking)", () => {
    const videos = [video("v3", "birthday c"), video("v1", "birthday a"), video("v2", "birthday b")]
    const snapshot = { baseQuery: "bir", videos }
    expect(deriveVisibleResults(snapshot, "birthday", []).map((v) => v.videoId)).toEqual(["v3", "v1", "v2"])
  })

  it("never mutates the snapshot's own videos array", () => {
    const videos = [video("v1", "birthday")]
    const snapshot = { baseQuery: "bir", videos }
    deriveVisibleResults(snapshot, "birthday", [])
    expect(snapshot.videos).toBe(videos)
    expect(snapshot.videos).toHaveLength(1)
  })
})
