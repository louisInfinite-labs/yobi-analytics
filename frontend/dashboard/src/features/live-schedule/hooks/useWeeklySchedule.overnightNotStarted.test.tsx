import { act, renderHook } from "@testing-library/react"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useWeeklySchedule } from "./useWeeklySchedule"
import * as useLiveStreamsModule from "../../../shared/api/hooks/useLiveStreams"
import type { RecentlyEndedStreamDto } from "../../../shared/api/liveStreams"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

vi.mock("../../../shared/api/hooks/useLiveStreams", () => ({ useLiveStreams: vi.fn() }))

// The false-LIVE incident (2026-11-16): the backend listed two member streams (Arya Kuroha 2Qm0bOp7sks, Narin Mikure 2tOFQ_vG7s4) as "live" with no actualStart long after
// their scheduled start while YouTube still showed their waiting rooms. The backend now serves such a stream as "upcoming". A browser that had already remembered it as
// "seen live overnight" must release the held date from that fresh response -- not keep the old day pinned until its 24 h memory runs out -- while everything that is genuinely
// live (even with a temporarily missing actualStart), or that began, keeps holding exactly as before.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
const originalTz = env.TZ
const ZONES = ["Asia/Tokyo", "America/Los_Angeles"] as const
const KEY = "yobi.schedule.overnightPending"
const TICK_MS = 61_000

type StreamDto = ReturnType<typeof useLiveStreamsModule.useLiveStreams>["streams"][number]

// Built inside each test: the viewer timezone is set per test, so a start computed at module load would be in the wrong zone.
const aryaStart = () => new Date(2026, 10, 15, 8, 0) // Sunday 08:00 (viewer-local)
const narinStart = () => new Date(2026, 10, 15, 12, 30)

const base = (videoId: string, creatorId: string, start: Date): StreamDto => ({
  videoId,
  creatorId,
  channelName: creatorId,
  title: videoId,
  status: "live",
  scheduledStart: start.toISOString(),
  actualStart: null,
  thumbnailUrl: "",
  topic: null,
})
const falseLive = (videoId: string, creatorId: string, start: Date): StreamDto => base(videoId, creatorId, start) // live, no actualStart: what the backend served
const waitingRoom = (videoId: string, creatorId: string, start: Date): StreamDto => ({ ...base(videoId, creatorId, start), status: "upcoming" })
const genuinelyLive = (videoId: string, creatorId: string, start: Date): StreamDto => ({ ...base(videoId, creatorId, start), actualStart: start.toISOString() })
const ended = (videoId: string): RecentlyEndedStreamDto => ({ videoId, confirmedEndedAt: "2026-11-16T10:00:00Z" })

function mockStreams(streams: StreamDto[], { recentlyEnded = [], fetched = true }: { recentlyEnded?: RecentlyEndedStreamDto[]; fetched?: boolean } = {}) {
  vi.mocked(useLiveStreamsModule.useLiveStreams).mockReturnValue({ streams, isLoading: !fetched, error: null, recentlyEnded, fetchedThisSession: fetched })
}

const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)))
const tick = () => act(async () => void (await vi.advanceTimersByTimeAsync(TICK_MS)))
const at = (day: number, hour: number, minute: number, second = 0) => vi.setSystemTime(new Date(2026, 10, day, hour, minute, second))
const stored = (): Record<string, { startMs: number; lastSeenMs?: number; verified?: true }> => JSON.parse(window.localStorage.getItem(KEY) ?? "{}")
const reload = () => resetAllSharedStateForTests() // only localStorage survives a page load

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

describe.each(ZONES)("Schedule hold vs a stream the backend now lists as not started -- viewer timezone %s", (tz) => {
  beforeEach(() => {
    env.TZ = tz
  })

  it("holds Sunday while the backend still lists both streams live, then releases to today once it lists them as waiting rooms", async () => {
    at(16, 17, 0) // Monday
    mockStreams([falseLive("2Qm0bOp7sks", "arya_kuroha", aryaStart()), falseLive("2tOFQ_vG7s4", "narin_mikure", narinStart())])
    const { result, rerender } = renderHook(() => useWeeklySchedule())
    await flush()

    expect(result.current.weekStart).toEqual(new Date(2026, 10, 15)) // the incident: Sunday is pinned
    expect(result.current.holdPreviousDay).toBe(true)
    expect(Object.keys(stored()).sort()).toEqual(["2Qm0bOp7sks", "2tOFQ_vG7s4"])

    mockStreams([waitingRoom("2Qm0bOp7sks", "arya_kuroha", aryaStart()), waitingRoom("2tOFQ_vG7s4", "narin_mikure", narinStart())])
    rerender()
    await flush()
    await tick()

    expect(result.current.weekStart).toEqual(new Date(2026, 10, 16)) // today
    expect(result.current.holdPreviousDay).toBe(false)
    expect(stored()).toEqual({}) // the browser's own memory is cleaned up too
  })

  it("a browser that already remembered the false LIVE (stored entry, fresh page load) releases it from the first fresh response", async () => {
    at(16, 17, 0)
    window.localStorage.setItem(KEY, JSON.stringify({ "2Qm0bOp7sks": { creatorId: "arya_kuroha", startMs: aryaStart().getTime(), lastSeenMs: Date.now() - 600_000, verified: true } }))
    reload()
    mockStreams([waitingRoom("2Qm0bOp7sks", "arya_kuroha", aryaStart())], { fetched: false }) // the cached first render
    const { result, rerender } = renderHook(() => useWeeklySchedule())
    await flush()
    expect(result.current.holdPreviousDay).toBe(true) // a cached response is no evidence either way

    mockStreams([waitingRoom("2Qm0bOp7sks", "arya_kuroha", aryaStart())], { fetched: true })
    rerender()
    await flush()
    await tick()

    expect(result.current.weekStart).toEqual(new Date(2026, 10, 16))
    expect(result.current.holdPreviousDay).toBe(false)
    expect(stored()).toEqual({})
  })

  it("a stream that really starts hours late is live again and holds its date; its confirmed end then releases it", async () => {
    at(16, 17, 0)
    window.localStorage.setItem(KEY, JSON.stringify({ "2Qm0bOp7sks": { creatorId: "arya_kuroha", startMs: aryaStart().getTime(), lastSeenMs: Date.now() - 600_000, verified: true } }))
    reload()
    mockStreams([waitingRoom("2Qm0bOp7sks", "arya_kuroha", aryaStart())])
    const { result, rerender } = renderHook(() => useWeeklySchedule())
    await flush()
    await tick()
    expect(result.current.holdPreviousDay).toBe(false)

    at(16, 20, 0) // it finally starts
    mockStreams([{ ...genuinelyLive("2Qm0bOp7sks", "arya_kuroha", aryaStart()), scheduledStart: aryaStart().toISOString(), actualStart: new Date(2026, 10, 16, 20, 0).toISOString() }])
    rerender()
    await flush()
    await tick()
    expect(result.current.weekStart).toEqual(new Date(2026, 10, 15))
    expect(result.current.holdPreviousDay).toBe(true)

    at(16, 22, 0)
    mockStreams([], { recentlyEnded: [ended("2Qm0bOp7sks")] })
    rerender()
    await flush()
    await tick()
    expect(result.current.weekStart).toEqual(new Date(2026, 10, 16))
    expect(result.current.holdPreviousDay).toBe(false)
  })

  it("a genuine live member stream with a temporarily missing actualStart still holds its date", async () => {
    at(16, 1, 30) // after local midnight, the stream began the evening before
    const evening = new Date(2026, 10, 15, 22, 0)
    mockStreams([falseLive("live-now", "aizawa_ema", evening)]) // status live, actualStart not filled in yet -- exactly the shape of the false LIVE, but still "live"
    const { result } = renderHook(() => useWeeklySchedule())
    await flush()

    expect(result.current.weekStart).toEqual(new Date(2026, 10, 15))
    expect(result.current.holdPreviousDay).toBe(true)
  })

  it("an 'upcoming' listing that carries an actualStart (the stream did begin) never releases a remembered stream", async () => {
    at(16, 17, 0)
    window.localStorage.setItem(KEY, JSON.stringify({ marathon: { creatorId: "aizawa_ema", startMs: aryaStart().getTime(), lastSeenMs: Date.now() - 600_000, verified: true } }))
    reload()
    mockStreams([{ ...waitingRoom("marathon", "aizawa_ema", aryaStart()), actualStart: aryaStart().toISOString() }])
    const { result } = renderHook(() => useWeeklySchedule())
    await flush()
    await tick()

    expect(result.current.weekStart).toEqual(new Date(2026, 10, 15))
    expect(result.current.holdPreviousDay).toBe(true)
  })

  it("a stream that merely drops out of the response is still held until the backend confirms its end (unchanged)", async () => {
    at(16, 17, 0)
    mockStreams([genuinelyLive("running", "aizawa_ema", aryaStart())])
    const { result, rerender } = renderHook(() => useWeeklySchedule())
    await flush()
    expect(result.current.holdPreviousDay).toBe(true)

    mockStreams([]) // gone from the list for a poll, no recentlyEnded entry
    rerender()
    await flush()
    await tick()

    expect(result.current.weekStart).toEqual(new Date(2026, 10, 15))
    expect(result.current.holdPreviousDay).toBe(true)
  })
})
