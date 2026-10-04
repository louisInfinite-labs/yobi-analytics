import { afterEach, describe, expect, it, vi } from "vitest"
import type { LiveStreamDto } from "../../../shared/api/liveStreams"
import { LIVE_STATUS_UPCOMING_WINDOW_MS, isWithinLiveStatusUpcomingWindow, pickStatus } from "./creatorStatusSelection"

/** Oct 1 12:00 JST == 03:00Z. */
const NOW = new Date("2026-10-01T12:00:00+09:00")
const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000

function at(deltaMs: number): string {
  return new Date(NOW.getTime() + deltaMs).toISOString()
}

function stream(overrides: Partial<LiveStreamDto> & { videoId: string }): LiveStreamDto {
  return {
    creatorId: "aizawa_ema",
    channelName: "ema",
    title: `title ${overrides.videoId}`,
    status: "upcoming",
    scheduledStart: null,
    actualStart: null,
    thumbnailUrl: "",
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("LIVE_STATUS_UPCOMING_WINDOW_MS", () => {
  it("is exactly 24 hours", () => {
    expect(LIVE_STATUS_UPCOMING_WINDOW_MS).toBe(24 * HOUR)
  })
})

describe("pickStatus: live streams", () => {
  it("always includes a live stream, whatever its scheduledStart", () => {
    const farFuture = stream({ videoId: "live1", status: "live", scheduledStart: at(5 * 24 * HOUR), actualStart: at(-HOUR) })
    const noSchedule = stream({ videoId: "live2", status: "live", scheduledStart: null, actualStart: at(-HOUR) })

    expect(pickStatus([farFuture], NOW)).toEqual({ kind: "live", videoId: "live1", title: "title live1" })
    expect(pickStatus([noSchedule], NOW)).toEqual({ kind: "live", videoId: "live2", title: "title live2" })
  })

  it("prefers live over an upcoming stream inside the window", () => {
    const upcoming = stream({ videoId: "up", scheduledStart: at(HOUR) })
    const live = stream({ videoId: "live", status: "live", actualStart: at(-HOUR) })

    expect(pickStatus([upcoming, live], NOW).kind).toBe("live")
  })
})

describe("pickStatus: the next rolling 24 hours", () => {
  it("includes an upcoming stream at +23h59m", () => {
    const status = pickStatus([stream({ videoId: "a", scheduledStart: at(23 * HOUR + 59 * MINUTE) })], NOW)

    expect(status).toEqual({ kind: "upcoming", videoId: "a", title: "title a", scheduledStart: at(23 * HOUR + 59 * MINUTE) })
  })

  it("includes an upcoming stream at exactly +24h", () => {
    expect(pickStatus([stream({ videoId: "a", scheduledStart: at(24 * HOUR) })], NOW).kind).toBe("upcoming")
  })

  it("excludes an upcoming stream one millisecond or one minute past +24h", () => {
    expect(pickStatus([stream({ videoId: "a", scheduledStart: at(24 * HOUR + 1) })], NOW).kind).toBe("offline")
    expect(pickStatus([stream({ videoId: "a", scheduledStart: at(24 * HOUR + MINUTE) })], NOW).kind).toBe("offline")
  })

  it("applies the example from the spec at Oct 1 12:00 JST", () => {
    const inside = stream({ videoId: "in", scheduledStart: "2026-10-02T11:59:00+09:00" })
    const justOutside = stream({ videoId: "out1", scheduledStart: "2026-10-02T12:01:00+09:00" })
    const lateEvening = stream({ videoId: "out2", scheduledStart: "2026-10-02T23:45:00+09:00" })

    expect(pickStatus([inside], NOW).kind).toBe("upcoming")
    expect(pickStatus([justOutside], NOW).kind).toBe("offline")
    expect(pickStatus([lateEvening], NOW).kind).toBe("offline")
  })

  it.each([2, 3, 5, 7])("excludes an upcoming stream %i days out from Live Status", (days) => {
    expect(pickStatus([stream({ videoId: "far", scheduledStart: at(days * 24 * HOUR) })], NOW)).toEqual({ kind: "offline" })
  })

  it("excludes an upcoming stream that is not strictly after now (starting now, or already past)", () => {
    expect(pickStatus([stream({ videoId: "now", scheduledStart: at(0) })], NOW).kind).toBe("offline")
    expect(pickStatus([stream({ videoId: "past", scheduledStart: at(-MINUTE) })], NOW).kind).toBe("offline")
  })

  it("picks the nearest eligible stream, ignoring a past one and one beyond 24h", () => {
    const status = pickStatus(
      [
        stream({ videoId: "beyond", scheduledStart: at(30 * HOUR) }),
        stream({ videoId: "later", scheduledStart: at(10 * HOUR) }),
        stream({ videoId: "past", scheduledStart: at(-HOUR) }),
        stream({ videoId: "soonest", scheduledStart: at(2 * HOUR) }),
      ],
      NOW,
    )

    expect(status).toMatchObject({ kind: "upcoming", videoId: "soonest" })
  })

  it("is offline for no streams, and for an upcoming stream with a null or unparseable scheduledStart", () => {
    expect(pickStatus(undefined, NOW)).toEqual({ kind: "offline" })
    expect(pickStatus([], NOW)).toEqual({ kind: "offline" })
    expect(pickStatus([stream({ videoId: "n", scheduledStart: null })], NOW).kind).toBe("offline")
    expect(pickStatus([stream({ videoId: "g", scheduledStart: "not-a-date" })], NOW).kind).toBe("offline")
  })

  it("decides only from the `now` it is given, never the system clock", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z")) // far from NOW: a hidden Date.now() read would change the result
    const target = stream({ videoId: "a", scheduledStart: at(HOUR) })

    expect(pickStatus([target], NOW).kind).toBe("upcoming")
    expect(pickStatus([target], new Date(NOW.getTime() + 2 * HOUR)).kind).toBe("offline") // already past at that `now`
  })
})

describe("isWithinLiveStatusUpcomingWindow: ISO timestamps and offsets", () => {
  it("compares absolute instants regardless of the offset or Z form used", () => {
    // NOW is 2026-10-01T03:00:00Z, so +24h is 2026-10-02T03:00:00Z.
    expect(isWithinLiveStatusUpcomingWindow("2026-10-02T02:59:00Z", NOW)).toBe(true)
    expect(isWithinLiveStatusUpcomingWindow("2026-10-02T11:59:00+09:00", NOW)).toBe(true) // same instant as 02:59Z
    expect(isWithinLiveStatusUpcomingWindow("2026-10-01T21:59:00-05:00", NOW)).toBe(true) // same instant again
    expect(isWithinLiveStatusUpcomingWindow("2026-10-02T03:00:00Z", NOW)).toBe(true) // exactly +24h
    expect(isWithinLiveStatusUpcomingWindow("2026-10-01T22:00:00-05:00", NOW)).toBe(true) // exactly +24h, other offset
    expect(isWithinLiveStatusUpcomingWindow("2026-10-02T03:00:01Z", NOW)).toBe(false)
    expect(isWithinLiveStatusUpcomingWindow("2026-10-02T12:00:01+09:00", NOW)).toBe(false)
  })

  it("handles fractional seconds and rejects null / garbage", () => {
    expect(isWithinLiveStatusUpcomingWindow("2026-10-01T03:00:00.001Z", NOW)).toBe(true)
    expect(isWithinLiveStatusUpcomingWindow("2026-10-01T03:00:00.000Z", NOW)).toBe(false) // == now
    expect(isWithinLiveStatusUpcomingWindow(null, NOW)).toBe(false)
    expect(isWithinLiveStatusUpcomingWindow("", NOW)).toBe(false)
    expect(isWithinLiveStatusUpcomingWindow("garbage", NOW)).toBe(false)
  })
})
