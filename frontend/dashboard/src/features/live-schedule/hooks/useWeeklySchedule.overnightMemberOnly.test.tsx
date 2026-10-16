import { act, renderHook } from "@testing-library/react"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useWeeklySchedule } from "./useWeeklySchedule"
import * as useLiveStreamsModule from "../../../shared/api/hooks/useLiveStreams"
import type { RecentlyEndedStreamDto } from "../../../shared/api/liveStreams"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

vi.mock("../../../shared/api/hooks/useLiveStreams", () => ({ useLiveStreams: vi.fn() }))

// Only a MEMBER creator's channel can hold the Schedule date across midnight. GROUP and STAFF channels (hololive FLOW GLOW Station, vspo_official,
// holoAN room ...) can stay live for days, so they never hold it -- but their streams are still shown by the normal rule.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
const originalTz = env.TZ
const ZONES = ["Asia/Tokyo", "Pacific/Auckland", "America/Los_Angeles"] as const
const MEMBER = "aizawa_ema" // channelType "member"
const GROUP = "hololive_dev_is_flow_glow" // channelType "group" (the FLOW GLOW Station channel)
const GROUP_2 = "vspo_official" // channelType "group"
const STAFF = "holoan_room" // channelType "staff"
const TICK_MS = 61_000

type StreamDto = ReturnType<typeof useLiveStreamsModule.useLiveStreams>["streams"][number]

const dto = (videoId: string, creatorId: string, start: Date, status: StreamDto["status"] = "live"): StreamDto => ({
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
const ended = (videoId: string): RecentlyEndedStreamDto => ({ videoId, confirmedEndedAt: "2026-10-16T03:00:00Z" })

function mockStreams(streams: StreamDto[], recentlyEnded: RecentlyEndedStreamDto[] = []) {
  vi.mocked(useLiveStreamsModule.useLiveStreams).mockReturnValue({ streams, isLoading: false, error: null, recentlyEnded })
}
const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)))
const tick = () => act(async () => void (await vi.advanceTimersByTimeAsync(TICK_MS)))
const placedIds = (days: { slots: { videoId: string }[][] }[]) => days.flatMap((day) => day.slots.flat()).map((stream) => stream.videoId)

beforeEach(() => {
  vi.useFakeTimers()
  resetAllSharedStateForTests()
  window.localStorage.clear()
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

describe.each(ZONES)("member-only date hold -- viewer timezone %s", (tz) => {
  beforeEach(() => {
    env.TZ = tz
  })
  /** Thu 2026-09-24 00:30 local. */
  const afterMidnight = () => vi.setSystemTime(new Date(2026, 8, 24, 0, 30, 0))
  const wed2200 = () => new Date(2026, 8, 23, 22, 0, 0)

  it("a MEMBER stream live since the previous local day still holds the date (control: unchanged)", () => {
    afterMidnight()
    mockStreams([dto("member-overnight", MEMBER, wed2200())])

    const { result } = renderHook(() => useWeeklySchedule())

    expect(result.current.holdPreviousDay).toBe(true)
    expect(result.current.weekStart).toEqual(new Date(2026, 8, 23))
  })

  it.each([
    ["group (FLOW GLOW Station)", GROUP],
    ["group (vspo_official)", GROUP_2],
    ["staff (holoAN room)", STAFF],
  ])("a %s stream live since the previous local day does NOT hold the date: the window starts today", (_label, creatorId) => {
    afterMidnight()
    mockStreams([dto("channel-overnight", creatorId, wed2200())])

    const { result } = renderHook(() => useWeeklySchedule())

    expect(result.current.holdPreviousDay).toBe(false)
    expect(result.current.weekStart).toEqual(new Date(2026, 8, 24))
    expect(result.current.days.findIndex((day) => day.isToday)).toBe(0)
  })

  it("a group stream that has run for several days never pins the window to its start day, across any number of midnights", async () => {
    vi.setSystemTime(new Date(2026, 8, 21, 23, 59, 30))
    mockStreams([dto("station", GROUP, new Date(2026, 8, 21, 10, 0, 0))])
    const { result } = renderHook(() => useWeeklySchedule())
    expect(result.current.weekStart).toEqual(new Date(2026, 8, 21))

    for (const expectedToday of [22, 23, 24]) {
      await tick() // 00:00 of the next local day
      vi.setSystemTime(new Date(2026, 8, expectedToday, 0, 0, 40))
      await tick()
      expect(result.current.holdPreviousDay).toBe(false)
      expect(result.current.weekStart.getDate()).toBe(expectedToday)
    }
  })

  it("group / staff streams stay visible by the normal rule: one that starts inside the displayed days is placed, upcoming ones too", () => {
    afterMidnight()
    mockStreams([
      dto("group-live-today", GROUP, new Date(2026, 8, 24, 0, 10, 0)),
      dto("group-upcoming", GROUP_2, new Date(2026, 8, 25, 20, 0, 0), "upcoming"),
      dto("staff-upcoming", STAFF, new Date(2026, 8, 26, 21, 0, 0), "upcoming"),
    ])

    const { result } = renderHook(() => useWeeklySchedule())

    expect(placedIds(result.current.days).sort()).toEqual(["group-live-today", "group-upcoming", "staff-upcoming"])
    expect(result.current.scheduleStreams.map((stream) => stream.videoId).sort()).toEqual(["group-live-today", "group-upcoming", "staff-upcoming"])
  })

  it("a member and a group both overnight: only the member decides the held day (a group that started EARLIER cannot pull it back)", () => {
    afterMidnight()
    mockStreams([dto("station", GROUP, new Date(2026, 8, 21, 10, 0, 0)), dto("member-overnight", MEMBER, wed2200())])

    const { result } = renderHook(() => useWeeklySchedule())

    expect(result.current.weekStart).toEqual(new Date(2026, 8, 23)) // the member's start day, not Sep 21
    expect(placedIds(result.current.days)).toEqual(["member-overnight"])
  })

  it("the member hold still resolves normally: once the backend confirms the member's end the window returns to today", async () => {
    afterMidnight()
    mockStreams([dto("member-overnight", MEMBER, wed2200()), dto("station", GROUP, new Date(2026, 8, 21, 10, 0, 0))])
    const { result, rerender } = renderHook(() => useWeeklySchedule())
    await flush()
    expect(result.current.weekStart).toEqual(new Date(2026, 8, 23))

    mockStreams([dto("station", GROUP, new Date(2026, 8, 21, 10, 0, 0))], [ended("member-overnight")])
    rerender()
    await flush()

    expect(result.current.weekStart).toEqual(new Date(2026, 8, 24))
  })

  it("a remembered (persisted) group/staff entry from before this rule is ignored and dropped, while a remembered member entry still holds", async () => {
    afterMidnight()
    const recent = new Date(2026, 8, 24, 0, 0, 0).getTime()
    window.localStorage.setItem(
      "yobi.schedule.overnightPending",
      JSON.stringify({
        "old-group": { creatorId: GROUP, startMs: new Date(2026, 8, 21, 10, 0, 0).getTime(), lastSeenMs: recent },
        "old-staff": { creatorId: STAFF, startMs: new Date(2026, 8, 22, 10, 0, 0).getTime(), lastSeenMs: recent },
      }),
    )
    resetAllSharedStateForTests()
    mockStreams([])
    const { result, unmount } = renderHook(() => useWeeklySchedule())
    await flush()
    expect(result.current.weekStart).toEqual(new Date(2026, 8, 24)) // nothing held
    expect(JSON.parse(window.localStorage.getItem("yobi.schedule.overnightPending") ?? "{}")).toEqual({})
    unmount()

    window.localStorage.setItem(
      "yobi.schedule.overnightPending",
      JSON.stringify({ "old-member": { creatorId: MEMBER, startMs: wed2200().getTime(), lastSeenMs: recent } }),
    )
    resetAllSharedStateForTests()
    const again = renderHook(() => useWeeklySchedule())
    await flush()
    expect(again.result.current.weekStart).toEqual(new Date(2026, 8, 23))
  })
})
