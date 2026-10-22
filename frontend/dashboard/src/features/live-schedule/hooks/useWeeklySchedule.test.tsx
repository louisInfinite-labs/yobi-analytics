import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useWeeklySchedule } from "./useWeeklySchedule"
import * as useLiveStreamsModule from "../../../shared/api/hooks/useLiveStreams"

vi.mock("../../../shared/api/hooks/useLiveStreams", () => ({ useLiveStreams: vi.fn() }))

// The shared minute clock (shared/time/minuteClock.ts) ticks at wall-clock minute boundaries: advancing a full minute always crosses exactly one.
const TICK_MS = 60_000

/** A real registry creatorId -- toScheduledStream skips anything else. */
const CREATOR_ID = "aizawa_ema"

function mockStreams(streams: ReturnType<typeof useLiveStreamsModule.useLiveStreams>["streams"]) {
  vi.mocked(useLiveStreamsModule.useLiveStreams).mockReturnValue({ streams, isLoading: false, error: null })
}

/** Local-time constructor on purpose: the hook is user-local, never UTC. */
function startAt(year: number, monthIndex: number, day: number, hour: number, minute: number, second: number) {
  vi.setSystemTime(new Date(year, monthIndex, day, hour, minute, second))
}

function tick() {
  act(() => {
    vi.advanceTimersByTime(TICK_MS)
  })
}

const todayIndex = (days: { isToday: boolean }[]) => days.findIndex((day) => day.isToday)

beforeEach(() => {
  vi.useFakeTimers()
  mockStreams([])
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("useWeeklySchedule window", () => {
  it("keeps the same weekStart object across a status tick within the same local day", () => {
    startAt(2026, 8, 23, 10, 0, 10) // Wed 2026-09-23
    const { result } = renderHook(() => useWeeklySchedule())
    const before = result.current.weekStart

    tick()

    expect(result.current.now.getMinutes()).toBe(1) // the tick lands just after the next minute boundary (10:01:00)
    expect(result.current.now.getSeconds()).toBe(0)
    expect(result.current.weekStart).toBe(before)
  })

  it("moves 'today' (and weekStart with it) to the next day at local midnight", () => {
    startAt(2026, 8, 23, 23, 59, 40) // Wed 23:59:40
    const { result } = renderHook(() => useWeeklySchedule())
    expect(todayIndex(result.current.days)).toBe(0)
    expect(result.current.weekStart).toEqual(new Date(2026, 8, 23))

    tick() // Thu 00:00:00 (the minute boundary)

    expect(todayIndex(result.current.days)).toBe(0) // today is always day 0, no Sunday-week jump
    expect(result.current.weekStart).toEqual(new Date(2026, 8, 24))
  })

  it("always shows today through the next 6 days, never a Sunday-aligned calendar week", () => {
    startAt(2026, 8, 23, 10, 0, 0) // Wed 2026-09-23
    const { result } = renderHook(() => useWeeklySchedule())

    expect(result.current.days.map((day) => day.date)).toEqual([
      new Date(2026, 8, 23),
      new Date(2026, 8, 24),
      new Date(2026, 8, 25),
      new Date(2026, 8, 26),
      new Date(2026, 8, 27),
      new Date(2026, 8, 28),
      new Date(2026, 8, 29),
    ])
    expect(todayIndex(result.current.days)).toBe(0)
  })
})

describe("useWeeklySchedule real stream data", () => {
  it("places a resolvable creator's stream into the correct day/slot", () => {
    startAt(2026, 8, 23, 10, 0, 0)
    mockStreams([
      {
        videoId: "v1",
        creatorId: CREATOR_ID,
        channelName: "藍沢エマ",
        title: "Ranked",
        status: "live",
        scheduledStart: null,
        actualStart: new Date(2026, 8, 23, 12, 0, 0).toISOString(),
        thumbnailUrl: "https://img.youtube.com/vi/v1/hqdefault.jpg",
      },
    ])

    const { result } = renderHook(() => useWeeklySchedule())

    const todayStreams = result.current.days[0].slots.flat()
    expect(todayStreams).toHaveLength(1)
    expect(todayStreams[0]).toMatchObject({ videoId: "v1", status: "live", channelId: "ch_aizawa_ema" })
  })

  it("places a Premiere into its scheduled slot with status preserved as premiere (never relabeled upcoming)", () => {
    startAt(2026, 8, 23, 10, 0, 0)
    mockStreams([
      {
        videoId: "v-premiere",
        creatorId: CREATOR_ID,
        channelName: "藍沢エマ",
        title: "Cover MV",
        status: "premiere",
        scheduledStart: new Date(2026, 8, 23, 20, 0, 0).toISOString(),
        actualStart: null,
        thumbnailUrl: "https://img.youtube.com/vi/v-premiere/hqdefault.jpg",
      },
    ])

    const { result } = renderHook(() => useWeeklySchedule())

    const todayStreams = result.current.days[0].slots.flat()
    expect(todayStreams).toHaveLength(1)
    expect(todayStreams[0]).toMatchObject({ videoId: "v-premiere", status: "premiere", channelId: "ch_aizawa_ema" })
  })

  it("carries a stream's canonical backend topic through (so a creator + topic reminder can be resolved), and none when it has none", () => {
    startAt(2026, 8, 23, 10, 0, 0)
    const base = {
      creatorId: CREATOR_ID,
      channelName: "藍沢エマ",
      status: "live" as const,
      scheduledStart: null,
      actualStart: new Date(2026, 8, 23, 12, 0, 0).toISOString(),
      thumbnailUrl: "https://img.youtube.com/vi/v1/hqdefault.jpg",
    }
    mockStreams([
      { ...base, videoId: "v_sf6", title: "SF6 ranked", topic: "sf6" },
      { ...base, videoId: "v_none", title: "Ranked", topic: null },
      { ...base, videoId: "v_old_api", title: "Ranked" },
    ])

    const { result } = renderHook(() => useWeeklySchedule())

    const byId = Object.fromEntries(result.current.days[0].slots.flat().map((stream) => [stream.videoId, stream.topics]))
    expect(byId).toEqual({ v_sf6: ["sf6"], v_none: [], v_old_api: [] })
  })

  it("drops a stream whose creatorId isn't in the canonical registry", () => {
    startAt(2026, 8, 23, 10, 0, 0)
    mockStreams([
      {
        videoId: "v1",
        creatorId: "not_a_real_creator",
        channelName: "Unknown",
        title: "Ranked",
        status: "live",
        scheduledStart: null,
        actualStart: new Date(2026, 8, 23, 12, 0, 0).toISOString(),
        thumbnailUrl: "https://img.youtube.com/vi/v1/hqdefault.jpg",
      },
    ])

    const { result } = renderHook(() => useWeeklySchedule())

    expect(result.current.days.flatMap((day) => day.slots.flat())).toHaveLength(0)
  })

  it("drops an upcoming stream with neither scheduledStart nor actualStart", () => {
    startAt(2026, 8, 23, 10, 0, 0)
    mockStreams([
      {
        videoId: "v1",
        creatorId: CREATOR_ID,
        channelName: "藍沢エマ",
        title: "Ranked",
        status: "upcoming",
        scheduledStart: null,
        actualStart: null,
        thumbnailUrl: "https://img.youtube.com/vi/v1/hqdefault.jpg",
      },
    ])

    const { result } = renderHook(() => useWeeklySchedule())

    expect(result.current.days.flatMap((day) => day.slots.flat())).toHaveLength(0)
  })
})

describe("useWeeklySchedule scheduleStreams (what the creator filter may offer)", () => {
  const dto = (videoId: string, start: Date, creatorId = CREATOR_ID) => ({
    videoId,
    creatorId,
    channelName: creatorId,
    title: videoId,
    status: "upcoming" as const,
    scheduledStart: start.toISOString(),
    actualStart: null,
    thumbnailUrl: "",
    topic: null,
  })

  it("holds exactly the streams on the displayed days -- local date boundaries inclusive of the last slot, exclusive of the next midnight and of the day before", () => {
    startAt(2026, 8, 23, 10, 0, 0) // displayed: Sep 23 00:00 .. Sep 29 23:59 local
    mockStreams([
      dto("before", new Date(2026, 8, 22, 23, 59, 0)),
      dto("first-slot", new Date(2026, 8, 23, 0, 0, 0)),
      dto("last-slot", new Date(2026, 8, 29, 23, 30, 0)),
      dto("after", new Date(2026, 8, 30, 0, 0, 0)),
    ])

    const { result } = renderHook(() => useWeeklySchedule())

    expect(result.current.scheduleStreams.map((stream) => stream.videoId)).toEqual(["first-slot", "last-slot"])
    // the grid places the very same set (nothing offered that the grid does not show)
    expect(result.current.days.flatMap((day) => day.slots.flat()).map((stream) => stream.videoId)).toEqual(["first-slot", "last-slot"])
  })

  it("is independent of the creator / organization filters (the choices never shrink to the current selection)", () => {
    startAt(2026, 8, 23, 10, 0, 0)
    mockStreams([dto("ema", new Date(2026, 8, 24, 20, 0, 0)), dto("pekora", new Date(2026, 8, 24, 21, 0, 0), "usada_pekora")])

    const { result } = renderHook(() => useWeeklySchedule(new Set(["ch_usada_pekora"]), "hololive"))

    expect(result.current.scheduleStreams.map((stream) => stream.videoId)).toEqual(["ema", "pekora"])
    expect(result.current.days.flatMap((day) => day.slots.flat()).map((stream) => stream.videoId)).toEqual(["pekora"])
  })

  it("is recomputed when the displayed range moves (local midnight): yesterday's stream leaves, the newly reached day's stream enters", () => {
    startAt(2026, 8, 23, 23, 59, 40)
    mockStreams([dto("today", new Date(2026, 8, 23, 23, 0, 0)), dto("day8", new Date(2026, 8, 30, 12, 0, 0))])
    const { result } = renderHook(() => useWeeklySchedule())
    expect(result.current.scheduleStreams.map((stream) => stream.videoId)).toEqual(["today"])

    tick() // Thu Sep 24 00:00 -> displayed Sep 24 .. Sep 30

    expect(result.current.scheduleStreams.map((stream) => stream.videoId)).toEqual(["day8"])
  })
})
