import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useCreatorStatuses } from "./useCreatorStatuses"
import { useWeeklySchedule } from "../../live-schedule/hooks/useWeeklySchedule"
import * as useLiveStreamsModule from "../../../shared/api/hooks/useLiveStreams"
import type { LiveStreamDto } from "../../../shared/api/liveStreams"

vi.mock("../../../shared/api/hooks/useLiveStreams", () => ({ useLiveStreams: vi.fn() }))

/** A real registry creatorId (its legacy roster id is ch_aizawa_ema). */
const CREATOR_ID = "aizawa_ema"
const LEGACY_ID = "ch_aizawa_ema"
const NOW = new Date("2026-10-01T12:00:00+09:00")
const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const DAY = 24 * HOUR

function dto(videoId: string, deltaMs: number, status: LiveStreamDto["status"] = "upcoming"): LiveStreamDto {
  return {
    videoId,
    creatorId: CREATOR_ID,
    channelName: "ema",
    title: `title ${videoId}`,
    status,
    scheduledStart: new Date(NOW.getTime() + deltaMs).toISOString(),
    actualStart: status === "live" ? new Date(NOW.getTime() - HOUR).toISOString() : null,
    thumbnailUrl: "",
  }
}

function mockStreams(streams: LiveStreamDto[]) {
  vi.mocked(useLiveStreamsModule.useLiveStreams).mockReturnValue({ streams, isLoading: false, error: null })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("useCreatorStatuses (Live Status) vs the shared 7-day /live-streams list", () => {
  it("shows an upcoming stream inside 24h, and not one 2-7 days out", () => {
    mockStreams([dto("soon", 23 * HOUR + 59 * MINUTE)])
    expect(renderHook(() => useCreatorStatuses()).result.current.statuses[LEGACY_ID]).toMatchObject({ kind: "upcoming", videoId: "soon" })

    for (const days of [2, 3, 7]) {
      mockStreams([dto("far", days * DAY)])
      expect(renderHook(() => useCreatorStatuses()).result.current.statuses[LEGACY_ID]).toEqual({ kind: "offline" })
    }
  })

  it("always shows a live stream", () => {
    mockStreams([dto("live", 5 * DAY, "live")])

    expect(renderHook(() => useCreatorStatuses()).result.current.statuses[LEGACY_ID]).toMatchObject({ kind: "live", videoId: "live" })
  })

  it("lets a stream enter the window as the rolling 24h boundary reaches it on the status tick", () => {
    mockStreams([dto("later", 24 * HOUR + 20 * MINUTE)])
    const { result } = renderHook(() => useCreatorStatuses())
    expect(result.current.statuses[LEGACY_ID]).toEqual({ kind: "offline" })

    act(() => {
      vi.advanceTimersByTime(21 * MINUTE) // 30s ticks: now is ~21 min later, so the stream is ~23h59m away
    })

    expect(result.current.statuses[LEGACY_ID]).toMatchObject({ kind: "upcoming", videoId: "later" })
  })

  it("does not narrow the shared list: Schedule still receives the same 7-day streams", () => {
    const streams = [dto("in-window", 5 * HOUR), dto("day3", 3 * DAY), dto("day6", 6 * DAY)]
    mockStreams(streams)

    const statuses = renderHook(() => useCreatorStatuses()).result.current.statuses
    const schedule = renderHook(() => useWeeklySchedule()).result.current

    // Live Status: only the 5h stream is eligible (nearest upcoming inside 24h).
    expect(statuses[LEGACY_ID]).toMatchObject({ kind: "upcoming", videoId: "in-window" })
    // Schedule: all three, including the 3- and 6-day streams, are on the 7-day grid.
    const scheduled = schedule.days.flatMap((day) => day.slots.flat()).map((entry) => entry.videoId)
    expect(scheduled.sort()).toEqual(["day3", "day6", "in-window"])
    // And the shared payload itself is untouched by the Live Status selection.
    expect(streams).toHaveLength(3)
    expect(vi.mocked(useLiveStreamsModule.useLiveStreams)().streams).toBe(streams)
  })
})
