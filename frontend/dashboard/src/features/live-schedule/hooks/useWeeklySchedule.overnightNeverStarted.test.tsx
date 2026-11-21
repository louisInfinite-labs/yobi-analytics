import { act, renderHook } from "@testing-library/react"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useWeeklySchedule } from "./useWeeklySchedule"
import * as useLiveStreamsModule from "../../../shared/api/hooks/useLiveStreams"
import type { NeverStartedStreamDto, RecentlyEndedStreamDto } from "../../../shared/api/liveStreams"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

vi.mock("../../../shared/api/hooks/useLiveStreams", () => ({ useLiveStreams: vi.fn() }))

// The Arya Kuroha remembered-hold incident (2026-11-16/17): a browser remembered a member stream as "seen live overnight"; Holodex then DROPPED it before the lifecycle could
// watch it, YouTube kept showing the waiting room, and the stream never ended -- so nothing ever released the held date until the browser's 24 h memory ran out. The backend now
// lists such a stream in `neverStarted` (explicit YouTube evidence, several separate checks). The Schedule must release the held date from that fresh signal -- and ONLY from it:
// a genuine overnight/multi-day stream that merely drops out of the response (an upstream gap) keeps holding exactly as before, as does one the response shows live with a start.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
const originalTz = env.TZ
const ZONES = ["Asia/Tokyo", "America/Los_Angeles"] as const
const KEY = "yobi.schedule.overnightPending"
const TICK_MS = 61_000
const ARYA = "2Qm0bOp7sks"

type StreamDto = ReturnType<typeof useLiveStreamsModule.useLiveStreams>["streams"][number]

// Built inside each test: the viewer timezone is set per test, so a start computed at module load would be in the wrong zone.
const aryaStart = () => new Date(2026, 10, 15, 8, 0) // Sunday 08:00 (viewer-local)
const marathonStart = () => new Date(2026, 10, 15, 21, 0)

const base = (videoId: string, creatorId: string, start: Date): StreamDto => ({
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
const genuinelyLive = (videoId: string, creatorId: string, start: Date): StreamDto => base(videoId, creatorId, start)
const ended = (videoId: string): RecentlyEndedStreamDto => ({ videoId, confirmedEndedAt: "2026-11-16T10:00:00Z" })
const never = (videoId: string): NeverStartedStreamDto => ({ videoId, confirmedAt: "2026-11-17T01:00:00Z" })

function mockStreams(
  streams: StreamDto[],
  { recentlyEnded = [], neverStarted, fetched = true }: { recentlyEnded?: RecentlyEndedStreamDto[]; neverStarted?: NeverStartedStreamDto[]; fetched?: boolean } = {},
) {
  vi.mocked(useLiveStreamsModule.useLiveStreams).mockReturnValue({ streams, isLoading: !fetched, error: null, recentlyEnded, ...(neverStarted ? { neverStarted } : {}), fetchedThisSession: fetched })
}

const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)))
const tick = () => act(async () => void (await vi.advanceTimersByTimeAsync(TICK_MS)))
const at = (day: number, hour: number, minute: number) => vi.setSystemTime(new Date(2026, 10, day, hour, minute, 0))
const stored = (): Record<string, { startMs: number; lastSeenMs?: number; verified?: true }> => JSON.parse(window.localStorage.getItem(KEY) ?? "{}")
const reload = () => resetAllSharedStateForTests() // only localStorage survives a page load
const remember = (videoId: string, creatorId: string, startMs: number) =>
  window.localStorage.setItem(KEY, JSON.stringify({ [videoId]: { creatorId, startMs, lastSeenMs: Date.now() - 600_000, verified: true } }))

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

describe.each(ZONES)("Schedule hold vs a stream the backend confirmed never started -- viewer timezone %s", (tz) => {
  beforeEach(() => {
    env.TZ = tz
  })

  it("Arya's case: a remembered stream that vanished from /live-streams releases the held date once a fresh response lists it in neverStarted", async () => {
    at(17, 9, 0) // Tuesday morning
    remember(ARYA, "arya_kuroha", aryaStart().getTime())
    reload()
    mockStreams([]) // Holodex dropped it: it is in neither streams nor recentlyEnded -- the pre-fix response
    const { result, rerender } = renderHook(() => useWeeklySchedule())
    await flush()
    await tick()
    expect(result.current.weekStart).toEqual(new Date(2026, 10, 15)) // pinned to Sunday: nothing can release it
    expect(result.current.holdPreviousDay).toBe(true)
    expect(Object.keys(stored())).toEqual([ARYA])

    mockStreams([], { neverStarted: [never(ARYA)] })
    rerender()
    await flush()
    await tick()

    expect(result.current.weekStart).toEqual(new Date(2026, 10, 17)) // today
    expect(result.current.holdPreviousDay).toBe(false)
    expect(stored()).toEqual({}) // the browser's own memory is cleaned up too
  })

  it("a cached first render (previous session's response) is no evidence: the hold stays until the first FRESH response carries the signal", async () => {
    at(17, 9, 0)
    remember(ARYA, "arya_kuroha", aryaStart().getTime())
    reload()
    mockStreams([], { neverStarted: [never(ARYA)], fetched: false }) // liveStreamsStore starts from the cached response
    const { result, rerender } = renderHook(() => useWeeklySchedule())
    await flush()
    expect(result.current.holdPreviousDay).toBe(true)

    mockStreams([], { neverStarted: [never(ARYA)], fetched: true })
    rerender()
    await flush()
    await tick()

    expect(result.current.weekStart).toEqual(new Date(2026, 10, 17))
    expect(result.current.holdPreviousDay).toBe(false)
    expect(stored()).toEqual({})
  })

  it("a genuine overnight stream that merely drops out of the response (an upstream gap) keeps holding: no signal, no release", async () => {
    at(17, 9, 0)
    remember("marathon", "aizawa_ema", marathonStart().getTime())
    reload()
    mockStreams([]) // gone from the list for a while, not confirmed ended, not listed in neverStarted
    const { result, rerender } = renderHook(() => useWeeklySchedule())
    await flush()
    await tick()
    expect(result.current.weekStart).toEqual(new Date(2026, 10, 15))

    mockStreams([], { neverStarted: [never("some-other-video")] }) // a signal for a DIFFERENT stream releases nothing here
    rerender()
    await flush()
    await tick()

    expect(result.current.weekStart).toEqual(new Date(2026, 10, 15))
    expect(result.current.holdPreviousDay).toBe(true)
    expect(Object.keys(stored())).toEqual(["marathon"])
  })

  it("releases only the confirmed stream: a genuine marathon remembered next to it keeps its own date", async () => {
    at(17, 9, 0)
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        [ARYA]: { creatorId: "arya_kuroha", startMs: aryaStart().getTime(), lastSeenMs: Date.now() - 600_000, verified: true },
        marathon: { creatorId: "aizawa_ema", startMs: marathonStart().getTime(), lastSeenMs: Date.now() - 600_000, verified: true },
      }),
    )
    reload()
    mockStreams([], { neverStarted: [never(ARYA)] })
    const { result } = renderHook(() => useWeeklySchedule())
    await flush()
    await tick()

    expect(result.current.weekStart).toEqual(new Date(2026, 10, 15)) // the marathon still holds Sunday
    expect(Object.keys(stored())).toEqual(["marathon"])
  })

  it("a stream the response lists live WITH a start of its own is never released by a (stale) neverStarted entry: Holodex's start evidence wins", async () => {
    at(17, 9, 0)
    mockStreams([genuinelyLive(ARYA, "arya_kuroha", aryaStart())], { neverStarted: [never(ARYA)] })
    const { result } = renderHook(() => useWeeklySchedule())
    await flush()
    await tick()

    expect(result.current.weekStart).toEqual(new Date(2026, 10, 15))
    expect(result.current.holdPreviousDay).toBe(true)
  })

  it("a stream released as never started that really starts hours late is live again and holds its date; its confirmed end then releases it", async () => {
    at(17, 9, 0)
    remember(ARYA, "arya_kuroha", aryaStart().getTime())
    reload()
    mockStreams([], { neverStarted: [never(ARYA)] })
    const { result, rerender } = renderHook(() => useWeeklySchedule())
    await flush()
    await tick()
    expect(result.current.holdPreviousDay).toBe(false)

    at(17, 20, 0) // it finally starts
    mockStreams([genuinelyLive(ARYA, "arya_kuroha", aryaStart())]) // the signal is gone, Holodex lists it live with an actualStart
    rerender()
    await flush()
    await tick()
    expect(result.current.weekStart).toEqual(new Date(2026, 10, 15))
    expect(result.current.holdPreviousDay).toBe(true)

    at(17, 22, 0)
    mockStreams([], { recentlyEnded: [ended(ARYA)] })
    rerender()
    await flush()
    await tick()
    expect(result.current.weekStart).toEqual(new Date(2026, 10, 17))
    expect(result.current.holdPreviousDay).toBe(false)
  })

  it("without the field (an older backend, a read failure, nothing to release) behaviour is exactly as before", async () => {
    at(17, 9, 0)
    remember(ARYA, "arya_kuroha", aryaStart().getTime())
    reload()
    mockStreams([]) // no neverStarted at all
    const { result } = renderHook(() => useWeeklySchedule())
    await flush()
    await tick()

    expect(result.current.weekStart).toEqual(new Date(2026, 10, 15))
    expect(result.current.holdPreviousDay).toBe(true)
  })
})
