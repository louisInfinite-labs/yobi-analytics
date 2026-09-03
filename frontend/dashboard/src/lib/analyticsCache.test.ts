import { describe, expect, it } from "vitest"
import { isNewer, readCache, writeCache, type CacheEntry, type CacheKey } from "./analyticsCache"

/** A minimal in-memory Storage implementation, isolated per test (no shared jsdom localStorage state). */
function memoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}

/** Build a minimal CacheEntry for a test, overriding only the given fields. */
function entry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    timeZone: "Asia/Tokyo",
    reportDate: "2026-09-03",
    comparisonDate: "2026-09-02",
    period: "1d",
    fetchedAt: "2026-09-03T18:00:00.000Z",
    results: [],
    ...overrides,
  }
}

const key: CacheKey = { timeZone: "Asia/Tokyo", reportDate: "2026-09-03", period: "1d" }

describe("readCache / writeCache", () => {
  it("returns null when nothing is cached", () => {
    expect(readCache(key, memoryStorage())).toBeNull()
  })

  it("round-trips a written entry", () => {
    const storage = memoryStorage()
    writeCache(key, entry(), storage)
    expect(readCache(key, storage)).toEqual(entry())
  })

  it("keeps entries for different (timeZone, reportDate, period) combinations separate", () => {
    const storage = memoryStorage()
    const tokyoKey: CacheKey = { timeZone: "Asia/Tokyo", reportDate: "2026-09-01", period: "1d" }
    const hkKey: CacheKey = { timeZone: "Asia/Hong_Kong", reportDate: "2026-08-31", period: "1d" }
    writeCache(tokyoKey, entry({ timeZone: "Asia/Tokyo", reportDate: "2026-09-01" }), storage)
    writeCache(hkKey, entry({ timeZone: "Asia/Hong_Kong", reportDate: "2026-08-31" }), storage)

    expect(readCache(tokyoKey, storage)?.reportDate).toBe("2026-09-01")
    expect(readCache(hkKey, storage)?.reportDate).toBe("2026-08-31")
  })

  it("readCache returns null for corrupt JSON rather than throwing", () => {
    const storage = memoryStorage()
    storage.setItem("yobi-analytics-cache:Asia/Tokyo:2026-09-03:1d", "{not json")
    expect(readCache(key, storage)).toBeNull()
  })

  it("readCache returns null for a stored value missing required fields, not just a wrong-key mismatch", () => {
    // Matches the identity fields but is otherwise incomplete (e.g. an
    // older app version's shape, or a partially-written value) — a bare
    // `as CacheEntry` type assertion would let this through unchecked.
    const storage = memoryStorage()
    storage.setItem(
      "yobi-analytics-cache:Asia/Tokyo:2026-09-03:1d",
      JSON.stringify({ timeZone: "Asia/Tokyo", reportDate: "2026-09-03", period: "1d" }),
    )
    expect(readCache(key, storage)).toBeNull()
  })

  it("readCache returns null when a results element is malformed, not just when results itself is missing", () => {
    // Array.isArray([null]) and Array.isArray([{}]) are both true — this
    // must reject the individual elements, not just the array shape.
    const storage = memoryStorage()
    storage.setItem(
      "yobi-analytics-cache:Asia/Tokyo:2026-09-03:1d",
      JSON.stringify({ ...entry(), results: [null] }),
    )
    expect(readCache(key, storage)).toBeNull()

    storage.setItem(
      "yobi-analytics-cache:Asia/Tokyo:2026-09-03:1d",
      JSON.stringify({ ...entry(), results: [{}] }),
    )
    expect(readCache(key, storage)).toBeNull()
  })

  it("readCache accepts a well-formed results element", () => {
    const storage = memoryStorage()
    const validStat = {
      date: "2026-09-03",
      channelId: "ch_a",
      channelName: "Channel A",
      organization: "vspo",
      branch: "vspo_jp",
      groupKey: ["1期生"],
      channelType: "member",
      lifecycleStage: "active",
      videoId: "v1",
      videoTitle: "Video",
      contentFormat: "normal_video",
      contentTags: [],
      totalViews: 1000,
      dailyIncrease: 100,
      growthPercent: 10,
      collectedAt: "2026-09-03T18:00:00+09:00",
      status: "ok",
    }
    writeCache(key, entry({ results: [validStat as never] }), storage)

    expect(readCache(key, storage)?.results).toHaveLength(1)
  })

  it("writeCache never throws even if storage.setItem throws (quota/private mode)", () => {
    const storage = memoryStorage()
    storage.setItem = () => {
      throw new Error("QuotaExceededError")
    }
    expect(() => writeCache(key, entry(), storage)).not.toThrow()
  })

  it("readCache ignores a stored entry whose key fields don't match (defensive re-check)", () => {
    const storage = memoryStorage()
    writeCache(key, entry({ period: "7d" }), storage) // mismatched period written under the "1d" cache key
    expect(readCache(key, storage)).toBeNull()
  })
})

describe("isNewer", () => {
  it("is true when nothing is cached yet", () => {
    expect(isNewer(entry(), null)).toBe(true)
  })

  it("is true when the incoming fetchedAt is later", () => {
    const cached = entry({ fetchedAt: "2026-09-03T18:00:00.000Z" })
    const incoming = entry({ fetchedAt: "2026-09-03T19:00:00.000Z" })
    expect(isNewer(incoming, cached)).toBe(true)
  })

  it("is false when the incoming fetchedAt is not newer (including equal)", () => {
    const cached = entry({ fetchedAt: "2026-09-03T18:00:00.000Z" })
    expect(isNewer(entry({ fetchedAt: "2026-09-03T17:00:00.000Z" }), cached)).toBe(false)
    expect(isNewer(entry({ fetchedAt: "2026-09-03T18:00:00.000Z" }), cached)).toBe(false)
  })
})
