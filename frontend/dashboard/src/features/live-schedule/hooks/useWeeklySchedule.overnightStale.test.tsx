import { act, renderHook } from "@testing-library/react"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useWeeklySchedule } from "./useWeeklySchedule"
import * as useLiveStreamsModule from "../../../shared/api/hooks/useLiveStreams"
import type { RecentlyEndedStreamDto } from "../../../shared/api/liveStreams"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

vi.mock("../../../shared/api/hooks/useLiveStreams", () => ({ useLiveStreams: vi.fn() }))

// A page load starts from the PREVIOUS session's cached /live-streams response (liveStreamsStore.readCached, fetchedThisSession: false). Streams that ended days ago
// are still "live" in it, so counting them as seen live re-armed the 24 h clock on every cold load and pinned the Schedule window to their start day (the Nov 12 window
// seen on Nov 15). Only a response fetched in this session is evidence; a stored entry nobody verified is dropped; a genuinely running multi-day stream still holds.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
const originalTz = env.TZ
const ZONES = ["Asia/Tokyo", "America/Los_Angeles"] as const
const KEY = "yobi.schedule.overnightPending"
const TICK_MS = 61_000

type StreamDto = ReturnType<typeof useLiveStreamsModule.useLiveStreams>["streams"][number]

const dto = (videoId: string, creatorId: string, start: Date): StreamDto => ({
  videoId,
  creatorId,
  channelName: creatorId,
  title: videoId,
  status: "live",
  scheduledStart: start.toISOString(),
  actualStart: start.toISOString(),
  thumbnailUrl: "",
  topic: null,
})
const ended = (videoId: string): RecentlyEndedStreamDto => ({ videoId, confirmedEndedAt: "2026-11-15T00:00:00Z" })

/** `fetched: false` is the cached first render of a page load (the previous session's response, not yet refreshed). */
function mockStreams(streams: StreamDto[], { recentlyEnded = [], fetched = true }: { recentlyEnded?: RecentlyEndedStreamDto[]; fetched?: boolean } = {}) {
  vi.mocked(useLiveStreamsModule.useLiveStreams).mockReturnValue({ streams, isLoading: !fetched, error: null, recentlyEnded, fetchedThisSession: fetched })
}

const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)))
const tick = () => act(async () => void (await vi.advanceTimersByTimeAsync(TICK_MS)))
const at = (day: number, hour: number, minute: number, second = 0) => vi.setSystemTime(new Date(2026, 10, day, hour, minute, second))
const stored = (): Record<string, { startMs: number; lastSeenMs?: number; verified?: true }> => JSON.parse(window.localStorage.getItem(KEY) ?? "{}")
const reload = () => resetAllSharedStateForTests() // only localStorage survives a page load

// The four streams of the incident: member channels whose streams ran on Nov 12-13 and ended long ago, still listed as live in a stale cache.
const GHOSTS = [
  dto("2h5zCDLxXrA", "ichijou_ririka", new Date(2026, 10, 12, 21, 0)),
  dto("CpqdVhyXtfU", "kurumi_noa", new Date(2026, 10, 13, 13, 45)),
  dto("Fuz7OI0sD-A", "ginjo_saine", new Date(2026, 10, 13, 16, 0)),
  dto("tOAgPp4r7Is", "kaga_nazuna", new Date(2026, 10, 13, 16, 20)),
]
const legacyEntry = (creatorId: string, start: Date, lastSeen: Date) => ({ creatorId, startMs: start.getTime(), lastSeenMs: lastSeen.getTime() })

beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.clear()
  resetAllSharedStateForTests()
  mockStreams([])
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
afterAll(() => {
  if (originalTz === undefined) delete env.TZ
  else env.TZ = originalTz
})

describe.each(ZONES)("Schedule window vs stale / cached overnight state -- viewer timezone %s", (tz) => {
  beforeEach(() => {
    env.TZ = tz
  })

  describe("normal schedule behaviour", () => {
    it("starts on today with nothing overnight, and stores nothing", async () => {
      at(15, 12, 0)
      mockStreams([dto("today", "aizawa_ema", new Date(2026, 10, 15, 9, 0))])
      const { result } = renderHook(() => useWeeklySchedule())
      await flush()

      expect(result.current.weekStart).toEqual(new Date(2026, 10, 15))
      expect(result.current.holdPreviousDay).toBe(false)
      expect(result.current.days.findIndex((day) => day.isToday)).toBe(0)
      expect(stored()).toEqual({})
    })
  })

  describe("the incident: a previous session's cached response must not count as 'seen live'", () => {
    it("streams listed live only by the cached first render are never stored, and the window is today once the fresh response lands", async () => {
      at(15, 23, 25, 41)
      mockStreams(GHOSTS, { fetched: false }) // the cached first render
      const { result, rerender } = renderHook(() => useWeeklySchedule())
      await flush()
      expect(stored()).toEqual({}) // nothing stamped from the cache

      mockStreams([], { fetched: true }) // the fresh response: none of them is live
      rerender()
      await flush()
      await tick()

      expect(result.current.weekStart).toEqual(new Date(2026, 10, 15))
      expect(result.current.holdPreviousDay).toBe(false)
      expect(stored()).toEqual({})
    })

    it("a second cold load with the same stale cache still stores nothing (the 24 h clock is never re-armed)", async () => {
      at(15, 23, 25, 41)
      for (let load = 0; load < 3; load++) {
        reload()
        mockStreams(GHOSTS, { fetched: false })
        const { rerender, unmount } = renderHook(() => useWeeklySchedule())
        await flush()
        mockStreams([], { fetched: true })
        rerender()
        await flush()
        unmount()
      }
      expect(stored()).toEqual({})
    })

    it("a session that never gets a fresh response stores nothing from the cache either", async () => {
      at(15, 23, 25, 41)
      mockStreams(GHOSTS, { fetched: false })
      renderHook(() => useWeeklySchedule())
      await flush()
      await tick()
      await tick()

      expect(stored()).toEqual({})
    })
  })

  describe("stale / orphaned persisted entries recover on their own (no manual localStorage clearing)", () => {
    const seedIncidentEntries = () => {
      const stamp = new Date(2026, 10, 15, 23, 25, 41) // all four with the same recent lastSeen, exactly as found in the affected browser
      window.localStorage.setItem(
        KEY,
        JSON.stringify({
          "2h5zCDLxXrA": legacyEntry("ichijou_ririka", new Date(2026, 10, 12, 21, 0), stamp),
          CpqdVhyXtfU: legacyEntry("kurumi_noa", new Date(2026, 10, 13, 13, 45), stamp),
          "Fuz7OI0sD-A": legacyEntry("ginjo_saine", new Date(2026, 10, 13, 16, 0), stamp),
          tOAgPp4r7Is: legacyEntry("kaga_nazuna", new Date(2026, 10, 13, 16, 20), stamp),
        }),
      )
      reload()
    }

    it("the four unverified entries are dropped by the first fresh response, which shows none of them live: window = today, storage emptied", async () => {
      at(15, 23, 40)
      seedIncidentEntries()
      mockStreams([], { fetched: false })
      const { result, rerender } = renderHook(() => useWeeklySchedule())
      await flush()
      expect(result.current.weekStart).toEqual(new Date(2026, 10, 15)) // never held on their word while the response is still the cache

      mockStreams([], { fetched: true })
      rerender()
      await flush()

      expect(result.current.weekStart).toEqual(new Date(2026, 10, 15))
      expect(result.current.holdPreviousDay).toBe(false)
      expect(stored()).toEqual({})
    })

    it("an entry from before `verified` existed that IS live in the fresh response is verified and keeps holding its start day", async () => {
      at(15, 23, 40)
      window.localStorage.setItem(KEY, JSON.stringify({ marathon: legacyEntry("aizawa_ema", new Date(2026, 10, 12, 21, 0), new Date(2026, 10, 15, 23, 0)) }))
      reload()
      mockStreams([dto("marathon", "aizawa_ema", new Date(2026, 10, 12, 21, 0))], { fetched: true })
      const { result } = renderHook(() => useWeeklySchedule())
      await flush()

      expect(result.current.weekStart).toEqual(new Date(2026, 10, 12))
      expect(stored().marathon.verified).toBe(true)
    })

    it("a verified entry whose stream the backend can no longer confirm is still forgotten 24 h after it was last seen live", async () => {
      at(13, 0, 30)
      mockStreams([dto("orphan", "aizawa_ema", new Date(2026, 10, 12, 22, 0))])
      const { result } = renderHook(() => useWeeklySchedule())
      await flush()
      expect(stored().orphan.verified).toBe(true)
      mockStreams([]) // dropped, never confirmed

      at(13, 21, 59, 30)
      await tick()
      expect(result.current.weekStart).toEqual(new Date(2026, 10, 12))

      at(14, 1, 0, 30)
      await tick()
      expect(result.current.weekStart).toEqual(new Date(2026, 10, 14))
      expect(stored()).toEqual({})
    })
  })

  describe("a genuine multi-day stream keeps its original start day, and the window returns to today once it ends", () => {
    const marathon = () => dto("marathon", "aizawa_ema", new Date(2026, 10, 12, 21, 0))

    it("held across every midnight and across reloads (cached first render included), released the moment the backend confirms the end", async () => {
      at(13, 0, 30)
      mockStreams([marathon()])
      const { result, unmount } = renderHook(() => useWeeklySchedule())
      await flush()
      expect(result.current.weekStart).toEqual(new Date(2026, 10, 12))

      for (const day of [14, 15, 16]) {
        at(day, 0, 29, 30) // still live in every fresh poll
        await tick()
        expect(result.current.weekStart).toEqual(new Date(2026, 10, 12))
      }
      expect(stored().marathon.verified).toBe(true)
      unmount()

      reload() // a reload: the cached first render lists it live, then the fresh response confirms it
      mockStreams([marathon()], { fetched: false })
      const again = renderHook(() => useWeeklySchedule())
      await flush()
      expect(again.result.current.weekStart).toEqual(new Date(2026, 10, 12))
      mockStreams([marathon()], { fetched: true })
      again.rerender()
      await flush()
      expect(again.result.current.weekStart).toEqual(new Date(2026, 10, 12))
      expect(stored().marathon.verified).toBe(true)

      mockStreams([], { recentlyEnded: [ended("marathon")] }) // the backend confirms it ended
      again.rerender()
      await flush()

      expect(again.result.current.weekStart).toEqual(new Date(2026, 10, 16))
      expect(again.result.current.holdPreviousDay).toBe(false)
      expect(stored()).toEqual({})
    })

    it("a verified entry holds while offline (no fresh response this session): only unverified ones are ignored", async () => {
      at(16, 0, 30)
      mockStreams([marathon()])
      const first = renderHook(() => useWeeklySchedule())
      await flush()
      first.unmount()

      reload()
      mockStreams([], { fetched: false }) // offline: the cache is empty and no fetch has succeeded
      const { result } = renderHook(() => useWeeklySchedule())
      await flush()

      expect(result.current.weekStart).toEqual(new Date(2026, 10, 12))
      expect(stored().marathon.verified).toBe(true)
    })
  })
})
