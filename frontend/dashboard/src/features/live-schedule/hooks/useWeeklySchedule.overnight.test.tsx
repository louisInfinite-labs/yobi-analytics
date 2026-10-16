import { act, renderHook } from "@testing-library/react"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useWeeklySchedule } from "./useWeeklySchedule"
import * as useLiveStreamsModule from "../../../shared/api/hooks/useLiveStreams"
import type { RecentlyEndedStreamDto } from "../../../shared/api/liveStreams"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

vi.mock("../../../shared/api/hooks/useLiveStreams", () => ({ useLiveStreams: vi.fn() }))

// The Schedule window starts on the viewer's LOCAL today -- except while an overnight stream (one that was live after the viewer's local midnight had
// passed its start) is unresolved. It then starts on that stream's ORIGINAL local start date, for as long as it stays unresolved, across any number of
// midnights. A stream is resolved ONLY when the backend lists it in `recentlyEnded` (its 5-minute lifecycle verified the end against YouTube); the
// archive lookup is a separate backend job and the Schedule never looks at it. Everything is decided in the viewer's own timezone, so each scenario runs
// in several zones (the app tsconfig has no Node types: type the one global needed).
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
const originalTz = env.TZ

// Tokyo is UTC+9, Brisbane UTC+10 (no DST), Auckland UTC+12, Los Angeles UTC-7/-8 and London UTC+0/+1 (both with DST).
const ZONES = ["Asia/Tokyo", "Australia/Brisbane", "Pacific/Auckland", "America/Los_Angeles", "Europe/London"] as const
const SLOT_2200 = 44
const CREATOR_ID = "aizawa_ema" // a real registry creatorId -- toScheduledStream skips anything else
const OTHER_CREATOR_ID = "usada_pekora"
// One minute plus slack: the shared minute clock fires 20ms AFTER each wall-clock minute boundary, so exactly 60s can stop just short of it.
const TICK_MS = 61_000

type StreamDto = ReturnType<typeof useLiveStreamsModule.useLiveStreams>["streams"][number]

const dto = (videoId: string, start: Date, status: StreamDto["status"] = "live", creatorId = CREATOR_ID): StreamDto => ({
  videoId,
  creatorId,
  channelName: creatorId,
  title: videoId,
  status,
  scheduledStart: start.toISOString(),
  actualStart: status === "live" ? start.toISOString() : null,
  thumbnailUrl: "",
  topic: null,
})

/** A stream the backend has confirmed ended, with whatever archive state the separate lookup happens to be in -- which must never matter here. */
const ended = (videoId: string, archive?: RecentlyEndedStreamDto["archive"]): RecentlyEndedStreamDto => ({
  videoId,
  confirmedEndedAt: "2026-10-16T03:00:00Z",
  ...(archive ? { archive } : {}),
})

/** `recentlyEnded` null = the backend sent no end signal at all (older deployment): the hold is inert. */
function mockStreams(streams: StreamDto[], recentlyEnded: RecentlyEndedStreamDto[] | null = []) {
  vi.mocked(useLiveStreamsModule.useLiveStreams).mockReturnValue({ streams, isLoading: false, error: null, ...(recentlyEnded ? { recentlyEnded } : {}) })
}

const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)))
const tick = () => act(async () => void (await vi.advanceTimersByTimeAsync(TICK_MS)))
const slotIds = (day: { slots: { videoId: string }[][] }, slot = SLOT_2200) => day.slots[slot].map((stream) => stream.videoId)
const placedIds = (days: { slots: { videoId: string }[][] }[]) => days.flatMap((day) => day.slots.flat()).map((stream) => stream.videoId)
const dayNumbers = (days: { date: Date }[]) => days.map((day) => day.date.getDate())

beforeEach(() => {
  vi.useFakeTimers()
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

describe.each(ZONES)("overnight Schedule window -- viewer timezone %s", (tz) => {
  beforeEach(() => {
    env.TZ = tz
  })

  /** Thu 2026-09-24 00:30 local, with a stream that went live at 22:00 local on Wed 09-23. */
  const afterMidnight = () => vi.setSystemTime(new Date(2026, 8, 24, 0, 30, 0))
  const overnight = () => dto("overnight", new Date(2026, 8, 23, 22, 0, 0))

  it("keeps the previous local day while an overnight stream is still live, and places it there (still seven days)", () => {
    afterMidnight()
    mockStreams([overnight()])

    const { result } = renderHook(() => useWeeklySchedule())

    expect(result.current.holdPreviousDay).toBe(true)
    expect(result.current.weekStart).toEqual(new Date(2026, 8, 23))
    expect(result.current.days).toHaveLength(7)
    expect(result.current.days[0].date).toEqual(new Date(2026, 8, 23))
    expect(result.current.days[6].date).toEqual(new Date(2026, 8, 29))
    expect(result.current.days.findIndex((day) => day.isToday)).toBe(1) // today is still marked, one column in
    expect(slotIds(result.current.days[0])).toEqual(["overnight"])
  })

  it("starts on today when nothing is overnight (a stream that went live after midnight is today's, not overnight)", () => {
    afterMidnight()
    mockStreams([dto("after-midnight", new Date(2026, 8, 24, 0, 10, 0))])

    const { result } = renderHook(() => useWeeklySchedule())

    expect(result.current.holdPreviousDay).toBe(false)
    expect(result.current.weekStart).toEqual(new Date(2026, 8, 24))
    expect(result.current.days.findIndex((day) => day.isToday)).toBe(0)
  })

  it("is already held in the very render that crosses local midnight (no flicker to the new day and back)", async () => {
    vi.setSystemTime(new Date(2026, 8, 23, 23, 59, 40))
    mockStreams([overnight()])
    const { result } = renderHook(() => useWeeklySchedule())
    expect(result.current.holdPreviousDay).toBe(false) // still Sep 23: the stream started today
    expect(result.current.weekStart).toEqual(new Date(2026, 8, 23))

    await tick() // Thu 00:00 -- the stream started "the day before", and is still live

    expect(result.current.holdPreviousDay).toBe(true)
    expect(result.current.weekStart).toEqual(new Date(2026, 8, 23))
  })

  it("advances to today as soon as the backend confirms the stream ended -- whatever the archive lookup says (or hasn't yet)", async () => {
    for (const archive of [undefined, { status: "pending", attempts: 0 }, { status: "handed_off_to_daily_task", attempts: 3 }, { status: "available", attempts: 1 }]) {
      resetAllSharedStateForTests()
      afterMidnight()
      mockStreams([overnight()])
      const { result, rerender, unmount } = renderHook(() => useWeeklySchedule())
      await flush()
      expect(result.current.weekStart).toEqual(new Date(2026, 8, 23))

      mockStreams([], [ended("overnight", archive)]) // gone from the live list AND confirmed ended by the backend
      rerender()
      await flush()

      expect(result.current.holdPreviousDay).toBe(false)
      expect(result.current.weekStart).toEqual(new Date(2026, 8, 24))
      expect(result.current.days.findIndex((day) => day.isToday)).toBe(0)
      unmount()
    }
  })

  it("a stream that merely drops out of /live-streams is NOT an end: the date stays until the backend confirms it", async () => {
    afterMidnight()
    mockStreams([overnight()])
    const { result, rerender } = renderHook(() => useWeeklySchedule())
    await flush()

    mockStreams([]) // a fresh response without it -- indistinguishable from a Holodex gap
    rerender()
    await flush()
    await tick()
    expect(result.current.holdPreviousDay).toBe(true)
    expect(result.current.weekStart).toEqual(new Date(2026, 8, 23))

    mockStreams([overnight()]) // it comes back live: nothing ever moved
    rerender()
    await flush()
    expect(result.current.weekStart).toEqual(new Date(2026, 8, 23))
    expect(slotIds(result.current.days[0])).toEqual(["overnight"])
  })

  it("survives a reload while the stream is dropped and not yet confirmed", async () => {
    afterMidnight()
    mockStreams([overnight()])
    const first = renderHook(() => useWeeklySchedule())
    await flush()
    first.unmount()

    resetAllSharedStateForTests() // a reload: only localStorage survives
    mockStreams([]) // the fresh response no longer lists it
    const { result, rerender } = renderHook(() => useWeeklySchedule())
    await flush()
    expect(result.current.holdPreviousDay).toBe(true)
    expect(result.current.weekStart).toEqual(new Date(2026, 8, 23))

    mockStreams([], [ended("overnight")])
    rerender()
    await flush()
    expect(result.current.holdPreviousDay).toBe(false)
  })

  it("a stream the backend lists as ended but that is live again right now stays held (a stale record never overrides what is live)", async () => {
    afterMidnight()
    mockStreams([overnight()], [ended("overnight")])
    const { result } = renderHook(() => useWeeklySchedule())
    await flush()

    expect(result.current.holdPreviousDay).toBe(true)
    expect(result.current.weekStart).toEqual(new Date(2026, 8, 23))
  })

  it("when the backend sends NO end signal (older deployment) nothing is held: the Schedule starts today instead of waiting for a signal that cannot arrive", async () => {
    afterMidnight()
    mockStreams([overnight()], null)
    const { result } = renderHook(() => useWeeklySchedule())
    await flush()

    expect(result.current.holdPreviousDay).toBe(false)
    expect(result.current.weekStart).toEqual(new Date(2026, 8, 24))
  })

  it("keeps the previous-day window whatever the creator / organization filters select (the filters only narrow what is placed)", () => {
    afterMidnight()
    mockStreams([overnight(), dto("pekora", new Date(2026, 8, 24, 10, 0, 0), "upcoming", OTHER_CREATOR_ID)])

    const filtered = renderHook(() => useWeeklySchedule(new Set(["ch_usada_pekora"]), "hololive"))
    const all = renderHook(() => useWeeklySchedule())

    for (const { result } of [filtered, all]) {
      expect(result.current.holdPreviousDay).toBe(true)
      expect(result.current.weekStart).toEqual(new Date(2026, 8, 23))
    }
    expect(placedIds(filtered.result.current.days)).toEqual(["pekora"])
    expect(placedIds(all.result.current.days)).toEqual(["overnight", "pekora"])
  })
})

describe.each(ZONES)("retention across several local midnights -- viewer timezone %s", (tz) => {
  beforeEach(() => {
    env.TZ = tz
  })

  // Thu 2026-10-15 22:00 local: a stream starts. No DST change falls between Oct 15 and Oct 18 in any of these zones.
  const started = () => dto("marathon", new Date(2026, 9, 15, 22, 0, 0))
  const at = (day: number, hour: number, minute: number, second = 0) => vi.setSystemTime(new Date(2026, 9, day, hour, minute, second))

  it("Oct 16 00:30 live -> still live at Oct 17 00:30 (also after a reload) and Oct 18 00:30 -> Oct 18 02:00 backend confirms: starts Oct 15 until then, then Oct 18", async () => {
    at(16, 0, 30)
    mockStreams([started()])
    const first = renderHook(() => useWeeklySchedule())
    await flush()
    expect(first.result.current.weekStart).toEqual(new Date(2026, 9, 15)) // Oct 16 00:30, LIVE: the schedule starts Oct 15
    expect(slotIds(first.result.current.days[0])).toEqual(["marathon"])

    at(17, 0, 29, 30)
    await tick() // Oct 17 00:30 -- the second midnight, the stream is still live
    expect(first.result.current.weekStart).toEqual(new Date(2026, 9, 15)) // still Oct 15
    expect(dayNumbers(first.result.current.days)).toEqual([15, 16, 17, 18, 19, 20, 21])
    expect(first.result.current.days.findIndex((day) => day.isToday)).toBe(2)

    first.unmount()
    resetAllSharedStateForTests() // the tab is closed and reopened: only localStorage remembers it
    const second = renderHook(() => useWeeklySchedule())
    await flush()
    expect(second.result.current.weekStart).toEqual(new Date(2026, 9, 15))

    at(18, 0, 29, 30)
    await tick() // Oct 18 00:30 -- the third midnight, still live
    expect(second.result.current.weekStart).toEqual(new Date(2026, 9, 15))
    expect(dayNumbers(second.result.current.days)).toEqual([15, 16, 17, 18, 19, 20, 21])
    expect(second.result.current.days.findIndex((day) => day.isToday)).toBe(3)

    mockStreams([], [ended("marathon", { status: "pending", attempts: 0 })]) // the backend polling confirms it ended -- no archive needed
    at(18, 1, 59, 30)
    await tick() // Oct 18 02:00
    expect(second.result.current.holdPreviousDay).toBe(false)
    expect(second.result.current.weekStart).toEqual(new Date(2026, 9, 18))
    expect(dayNumbers(second.result.current.days)).toEqual([18, 19, 20, 21, 22, 23, 24])
    expect(second.result.current.days.findIndex((day) => day.isToday)).toBe(0)
  })

  it("a stream still LIVE for days keeps its original start date across every midnight", async () => {
    at(16, 0, 30)
    mockStreams([started()])
    const { result } = renderHook(() => useWeeklySchedule())
    await flush()

    for (const day of [17, 18, 19]) {
      at(day, 0, 29, 30)
      await tick()
      expect(result.current.weekStart).toEqual(new Date(2026, 9, 15))
      expect(slotIds(result.current.days[0])).toEqual(["marathon"])
    }
    expect(result.current.days.findIndex((day) => day.isToday)).toBe(4) // Oct 19
    expect(result.current.days).toHaveLength(7)
  })

  it("the date follows the EARLIEST unresolved stream and moves forward only as the backend confirms each one", async () => {
    at(17, 0, 30)
    const oct15 = dto("oct15", new Date(2026, 9, 15, 22, 0, 0)) // Ema
    const oct16 = dto("oct16", new Date(2026, 9, 16, 23, 0, 0), "live", OTHER_CREATOR_ID) // Pekora
    mockStreams([oct15, oct16])
    const { result, rerender } = renderHook(() => useWeeklySchedule())
    await flush()
    expect(result.current.weekStart).toEqual(new Date(2026, 9, 15))

    mockStreams([], [ended("oct16")]) // the LATER stream is confirmed first: the earlier one (dropped, unconfirmed) still holds Oct 15
    rerender()
    await flush()
    expect(result.current.weekStart).toEqual(new Date(2026, 9, 15))

    mockStreams([oct15], [ended("oct16")]) // ...and while it is still LIVE it holds Oct 15 the same
    rerender()
    await flush()
    expect(result.current.weekStart).toEqual(new Date(2026, 9, 15))

    mockStreams([], [ended("oct16"), ended("oct15")])
    rerender()
    await flush()
    expect(result.current.holdPreviousDay).toBe(false)
    expect(result.current.weekStart).toEqual(new Date(2026, 9, 17))
  })

  it("the earlier stream is confirmed first: the date advances to the next unresolved stream's own day, not straight to today", async () => {
    at(17, 0, 30)
    mockStreams([dto("oct15", new Date(2026, 9, 15, 22, 0, 0)), dto("oct16", new Date(2026, 9, 16, 23, 0, 0), "live", OTHER_CREATOR_ID)])
    const { result, rerender } = renderHook(() => useWeeklySchedule())
    await flush()

    mockStreams([], [ended("oct15")])
    rerender()
    await flush()
    expect(result.current.weekStart).toEqual(new Date(2026, 9, 16))
    expect(result.current.days.findIndex((day) => day.isToday)).toBe(1)

    mockStreams([], [ended("oct15"), ended("oct16")])
    rerender()
    await flush()
    expect(result.current.weekStart).toEqual(new Date(2026, 9, 17))
  })

  it("an unresolved stream from ten days ago still starts the window on ITS day: exactly seven days from Oct 15, today no longer shown, nothing shifted forward", async () => {
    at(25, 0, 30) // Sun Oct 25 -- the stream started Thu Oct 15 and is still live
    mockStreams([started()])
    const { result } = renderHook(() => useWeeklySchedule())
    await flush()

    expect(result.current.holdPreviousDay).toBe(true)
    expect(result.current.weekStart).toEqual(new Date(2026, 9, 15))
    expect(dayNumbers(result.current.days)).toEqual([15, 16, 17, 18, 19, 20, 21])
    expect(result.current.days.some((day) => day.isToday)).toBe(false)
    expect(slotIds(result.current.days[0])).toEqual(["marathon"])
  })

  it("a remembered stream the backend can no longer confirm (GET /live-streams lists an end for 24 h) is forgotten 24 h after it was last seen live, not held forever", async () => {
    at(16, 0, 30)
    mockStreams([started()]) // seen live at Oct 16 00:30
    const { result } = renderHook(() => useWeeklySchedule())
    await flush()
    mockStreams([]) // dropped and never confirmed

    at(16, 21, 59, 30) // 21.5 hours after it was last seen: still inside the window in which a confirmation could still be listed
    await tick()
    expect(result.current.holdPreviousDay).toBe(true)
    expect(result.current.weekStart).toEqual(new Date(2026, 9, 15))

    at(17, 0, 59, 30) // 24.5 hours after: no confirmation can be listed any more
    await tick()
    expect(result.current.holdPreviousDay).toBe(false)
    expect(result.current.weekStart).toEqual(new Date(2026, 9, 17))
  })

  it("the 24 h window runs from the last time the stream was SEEN LIVE: a stream that kept running for days is not forgotten the moment it drops out", async () => {
    at(16, 0, 30)
    mockStreams([started()])
    const { result } = renderHook(() => useWeeklySchedule())
    await flush()
    for (const day of [17, 18, 19]) {
      at(day, 0, 29, 30) // still live on every midnight, so last-seen keeps moving
      await tick()
    }

    mockStreams([]) // it finally drops out on Oct 19, four days after its start
    at(19, 1, 59, 30)
    await tick()

    expect(result.current.holdPreviousDay).toBe(true)
    expect(result.current.weekStart).toEqual(new Date(2026, 9, 15))
  })
})

describe("overnight is decided in the viewer's own timezone, never a fixed one", () => {
  // The same real instants in every zone: a stream that went live at 13:00Z, and "now" = 16:30Z.
  const WENT_LIVE = new Date("2026-09-23T13:00:00Z")
  const NOW = new Date("2026-09-23T16:30:00Z")

  it.each([
    ["Asia/Tokyo", "UTC+9: now Thu 09-24 01:30, the stream went live Wed 22:00 -> overnight", true],
    ["Australia/Brisbane", "UTC+10: now Thu 09-24 02:30, the stream went live Wed 23:00 -> overnight", true],
    ["Pacific/Auckland", "UTC+12: now Thu 09-24 05:30, the stream went live Thu 01:00 -> same day, not overnight", false],
    ["America/Los_Angeles", "UTC-7: now Wed 09-23 09:30, the stream went live Wed 06:00 -> same day, not overnight", false],
    ["Europe/London", "UTC+1: now Wed 09-23 17:30, the stream went live Wed 14:00 -> same day, not overnight", false],
  ] as const)("%s %s", (tz, _description, held) => {
    env.TZ = tz
    vi.setSystemTime(NOW)
    mockStreams([dto("same-instant", WENT_LIVE)])

    const { result } = renderHook(() => useWeeklySchedule())

    expect(result.current.holdPreviousDay).toBe(held)
    const localToday = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate())
    expect(result.current.weekStart).toEqual(new Date(localToday.getFullYear(), localToday.getMonth(), localToday.getDate() - (held ? 1 : 0)))
  })

  it("DST fall-back night in Los Angeles (25-hour day): a stream live across the repeated hour is still overnight at the next local midnight", async () => {
    env.TZ = "America/Los_Angeles"
    vi.setSystemTime(new Date(2026, 10, 1, 23, 59, 40)) // Sun 2026-11-01
    mockStreams([dto("long-night", new Date(2026, 10, 1, 21, 0, 0))])
    const { result } = renderHook(() => useWeeklySchedule())
    expect(result.current.holdPreviousDay).toBe(false)

    await tick() // Mon 11-02 00:00 local

    expect(result.current.holdPreviousDay).toBe(true)
    expect(result.current.weekStart).toEqual(new Date(2026, 10, 1))
    expect(result.current.days).toHaveLength(7)
    expect(result.current.days[6].date).toEqual(new Date(2026, 10, 7))
  })

  it("DST spring-forward night in Sydney (23-hour day, UTC+10 -> +11): the overnight stream is held and the seven local days stay aligned", async () => {
    env.TZ = "Australia/Sydney"
    vi.setSystemTime(new Date(2026, 9, 3, 23, 59, 40)) // Sat 2026-10-03; clocks jump 02:00 -> 03:00 on Sun 10-04
    mockStreams([dto("spring-night", new Date(2026, 9, 3, 22, 0, 0))])
    const { result } = renderHook(() => useWeeklySchedule())
    expect(result.current.holdPreviousDay).toBe(false)

    await tick() // Sun 10-04 00:00 local

    expect(result.current.holdPreviousDay).toBe(true)
    expect(result.current.weekStart).toEqual(new Date(2026, 9, 3))
    expect(dayNumbers(result.current.days)).toEqual([3, 4, 5, 6, 7, 8, 9])
    expect(slotIds(result.current.days[0])).toEqual(["spring-night"])
  })

  it("a hold carried across a DST change keeps its original local day (Los Angeles: stream from Sat 10-31 evening, held past the Nov 1 fall-back)", async () => {
    env.TZ = "America/Los_Angeles"
    vi.setSystemTime(new Date(2026, 10, 1, 0, 30, 0)) // Sun 11-01 00:30 PDT
    mockStreams([dto("sat-night", new Date(2026, 9, 31, 22, 0, 0))])
    const { result } = renderHook(() => useWeeklySchedule())
    await flush()
    expect(result.current.weekStart).toEqual(new Date(2026, 9, 31))

    vi.setSystemTime(new Date(2026, 10, 1, 23, 20, 0)) // Sun 11-01 23:20 PST (after the 25-hour Sunday): still live
    await tick()
    mockStreams([]) // dropped from the live list shortly before midnight; not confirmed ended
    vi.setSystemTime(new Date(2026, 10, 2, 0, 29, 30)) // Mon 11-02 00:29:30 PST, an hour later
    await tick()

    expect(result.current.weekStart).toEqual(new Date(2026, 9, 31))
    expect(dayNumbers(result.current.days)).toEqual([31, 1, 2, 3, 4, 5, 6])
    expect(result.current.days.findIndex((day) => day.isToday)).toBe(2)
  })
})