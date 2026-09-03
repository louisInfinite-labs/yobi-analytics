import { renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { writeCache, type CacheEntry, type CacheKey } from "../lib/analyticsCache"
import { useCachedDashboardData } from "./useCachedDashboardData"

const key: CacheKey = { timeZone: "Asia/Tokyo", reportDate: "2026-09-03", period: "1d" }

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

describe("useCachedDashboardData", () => {
  it("starts in loading with no entry when nothing is cached", () => {
    const fetchFn = vi.fn(() => new Promise<CacheEntry>(() => {})) // never resolves in this test
    const { result } = renderHook(() => useCachedDashboardData(key, fetchFn))

    expect(result.current.loading).toBe(true)
    expect(result.current.entry).toBeNull()
  })

  it("displays cached data immediately, without waiting for the fetch to resolve (Roadmap 3.6)", () => {
    writeCache(key, entry({ fetchedAt: "2026-09-03T10:00:00.000Z" }))
    const fetchFn = vi.fn(() => new Promise<CacheEntry>(() => {})) // deliberately never resolves

    const { result } = renderHook(() => useCachedDashboardData(key, fetchFn))

    expect(result.current.loading).toBe(false)
    expect(result.current.entry?.fetchedAt).toBe("2026-09-03T10:00:00.000Z")
  })

  it("surfaces a rejected fetch as `error` and stops loading, instead of an unhandled rejection", async () => {
    const fetchFn = vi.fn(() => Promise.reject(new Error("network down")))

    const { result } = renderHook(() => useCachedDashboardData(key, fetchFn))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error?.message).toBe("network down")
    expect(result.current.entry).toBeNull()
  })

  it("keeps showing cached data if the background fetch fails, rather than clearing it", async () => {
    writeCache(key, entry({ fetchedAt: "2026-09-03T10:00:00.000Z" }))
    const fetchFn = vi.fn(() => Promise.reject(new Error("network down")))

    const { result } = renderHook(() => useCachedDashboardData(key, fetchFn))

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.entry?.fetchedAt).toBe("2026-09-03T10:00:00.000Z")
  })

  it("switches to the new key's own cached entry immediately when key changes, never showing the old key's stale entry", () => {
    const keyA: CacheKey = { timeZone: "Asia/Tokyo", reportDate: "2026-09-03", period: "1d" }
    const keyB: CacheKey = { timeZone: "Asia/Tokyo", reportDate: "2026-09-03", period: "7d" }
    writeCache(keyA, entry({ period: "1d", fetchedAt: "2026-09-03T10:00:00.000Z" }))
    writeCache(keyB, entry({ period: "7d", fetchedAt: "2026-09-03T09:00:00.000Z" }))
    const fetchFn = vi.fn(() => new Promise<CacheEntry>(() => {})) // never resolves

    const { result, rerender } = renderHook(({ key }) => useCachedDashboardData(key, fetchFn), {
      initialProps: { key: keyA },
    })
    expect(result.current.entry?.period).toBe("1d")

    rerender({ key: keyB })

    // No intermediate render should ever have shown keyA's entry under keyB.
    expect(result.current.entry?.period).toBe("7d")
    expect(result.current.loading).toBe(false)
  })

  it("replaces the cache when the background fetch returns a newer entry", async () => {
    writeCache(key, entry({ fetchedAt: "2026-09-03T10:00:00.000Z" }))
    const fresh = entry({ fetchedAt: "2026-09-03T18:00:00.000Z" })
    const fetchFn = vi.fn(() => Promise.resolve(fresh))

    const { result } = renderHook(() => useCachedDashboardData(key, fetchFn))

    await waitFor(() => expect(result.current.entry?.fetchedAt).toBe("2026-09-03T18:00:00.000Z"))
    expect(result.current.loading).toBe(false)
  })

  it("does not replace the cache when the background fetch is not actually newer", async () => {
    const cached = entry({ fetchedAt: "2026-09-03T18:00:00.000Z" })
    writeCache(key, cached)
    const stale = entry({ fetchedAt: "2026-09-03T10:00:00.000Z" })
    const fetchFn = vi.fn(() => Promise.resolve(stale))

    const { result } = renderHook(() => useCachedDashboardData(key, fetchFn))

    await waitFor(() => expect(fetchFn).toHaveBeenCalled())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.entry?.fetchedAt).toBe("2026-09-03T18:00:00.000Z")
  })
})
