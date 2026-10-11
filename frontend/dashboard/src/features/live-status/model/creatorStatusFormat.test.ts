import { describe, expect, it } from "vitest"
import {
  formatAbsoluteTime,
  formatCountdown,
  formatLiveStart,
  formatStartedAgo,
  formatCreatorStatus,
  isScheduledTimeReached,
  reclassifyIfPastSchedule,
} from "./creatorStatusFormat"
import type { CreatorStatus } from "./creatorStatus"

describe("formatCountdown", () => {
  it("floors partial minutes rather than rounding", () => {
    const now = new Date("2026-09-09T00:00:00.000Z")
    // 65 minutes 59 seconds away — must read as 1h05m, not 1h06m.
    const target = new Date(now.getTime() + 65 * 60_000 + 59_000).toISOString()
    expect(formatCountdown(target, now)).toBe("1時間5分後")
  })

  it("never shows a negative value once the target time has passed", () => {
    const now = new Date("2026-09-09T12:00:00.000Z")
    const target = new Date("2026-09-09T11:00:00.000Z").toISOString()
    expect(formatCountdown(target, now)).toBe("0分後")
  })

  it("formats hours and minutes together for a target more than an hour away", () => {
    const now = new Date("2026-09-09T00:00:00.000Z")
    const target = new Date("2026-09-09T03:30:00.000Z").toISOString()
    expect(formatCountdown(target, now)).toBe("3時間30分後")
  })

  it("defaults to Japanese when no language is given", () => {
    const now = new Date("2026-09-09T00:00:00.000Z")
    const target = new Date("2026-09-09T01:05:00.000Z").toISOString()
    expect(formatCountdown(target, now)).toBe(formatCountdown(target, now, "ja"))
  })

  it("renders Chinese using an hours-minutes-later pattern", () => {
    const now = new Date("2026-09-09T00:00:00.000Z")
    const target = new Date("2026-09-09T01:05:00.000Z").toISOString()
    expect(formatCountdown(target, now, "zh-TW")).toBe("1小時5分鐘後")
  })

  it("renders English as In Xh Xm", () => {
    const now = new Date("2026-09-09T00:00:00.000Z")
    const target = new Date("2026-09-09T01:05:00.000Z").toISOString()
    expect(formatCountdown(target, now, "en")).toBe("In 1h 5m")
  })

  it.each([
    [5, { "zh-TW": "5分鐘後", ja: "5分後", en: "In 5m" }],
    [65, { "zh-TW": "1小時5分鐘後", ja: "1時間5分後", en: "In 1h 5m" }],
    [150, { "zh-TW": "2小時30分鐘後", ja: "2時間30分後", en: "In 2h 30m" }],
    [0, { "zh-TW": "0分鐘後", ja: "0分後", en: "In 0m" }],
  ] as const)("%i minutes away: the hour part is omitted while it is 0, and never a minute-only 65 / 150", (minutes, expected) => {
    const now = new Date("2026-09-09T00:00:00.000Z")
    const target = new Date(now.getTime() + minutes * 60_000).toISOString()

    for (const locale of ["zh-TW", "ja", "en"] as const) expect(formatCountdown(target, now, locale)).toBe(expected[locale])
  })

  it("never writes a zero-hour part (no 0小時5分鐘後 / 0時間5分後 / In 0h 5m)", () => {
    const now = new Date("2026-09-09T00:00:00.000Z")
    const target = new Date(now.getTime() + 5 * 60_000).toISOString()

    for (const locale of ["zh-TW", "ja", "en"] as const) expect(formatCountdown(target, now, locale)).not.toMatch(/0小時|0時間|0h/)
  })
})

describe("formatStartedAgo (a currently-live stream)", () => {
  const start = new Date("2026-09-09T00:00:00.000Z")
  const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000)

  it.each([
    [5, { "zh-TW": "5分鐘前開始", ja: "5分前に開始", en: "Started 5m ago" }],
    [65, { "zh-TW": "1小時5分鐘前開始", ja: "1時間5分前に開始", en: "Started 1h 5m ago" }],
    [349, { "zh-TW": "5小時49分鐘前開始", ja: "5時間49分前に開始", en: "Started 5h 49m ago" }],
  ] as const)("%i minutes after the actual start", (minutes, expected) => {
    for (const locale of ["zh-TW", "ja", "en"] as const) expect(formatStartedAgo(start.toISOString(), at(minutes), locale)).toBe(expected[locale])
  })

  it("floors partial minutes and is never negative", () => {
    expect(formatStartedAgo(start.toISOString(), new Date(start.getTime() + 5 * 60_000 + 59_000), "zh-TW")).toBe("5分鐘前開始")
    expect(formatStartedAgo(start.toISOString(), new Date(start.getTime() - 60_000), "zh-TW")).toBe("0分鐘前開始")
  })
})

describe("formatLiveStart", () => {
  const start = new Date(2026, 8, 9, 7, 45).toISOString()
  const now = new Date(2026, 8, 9, 13, 34)

  it("relative mode is the shared started-ago text; clock mode is the actual start time, with no elapsed minutes", () => {
    expect(formatLiveStart(start, "countdown", now, "zh-TW")).toBe("5小時49分鐘前開始")
    expect(formatLiveStart(start, "absolute", now, "zh-TW", "24h")).toBe("07:45")
    expect(formatLiveStart(start, "absolute", now, "zh-TW", "12h")).toBe(formatAbsoluteTime(start, "12h"))
  })
})

describe("formatAbsoluteTime", () => {
  it("zero-pads single-digit hours and minutes", () => {
    const target = new Date(2026, 8, 9, 9, 5).toISOString()
    expect(formatAbsoluteTime(target)).toBe("09:05")
  })
})

describe("isScheduledTimeReached / reclassifyIfPastSchedule", () => {
  it("treats the exact scheduled instant as reached", () => {
    const now = new Date("2026-09-09T12:00:00.000Z")
    expect(isScheduledTimeReached(now.toISOString(), now)).toBe(true)
  })

  it("reclassifies a past-due upcoming status to offline, not a distinct 'past' state", () => {
    const now = new Date("2026-09-09T12:00:00.000Z")
    const status: CreatorStatus = { kind: "upcoming", videoId: "v1", title: "t", scheduledStart: "2026-09-09T11:00:00.000Z" }
    expect(reclassifyIfPastSchedule(status, now)).toEqual({ kind: "offline" })
  })

  it("leaves a still-future upcoming status untouched", () => {
    const now = new Date("2026-09-09T12:00:00.000Z")
    const status: CreatorStatus = { kind: "upcoming", videoId: "v1", title: "t", scheduledStart: "2026-09-09T13:00:00.000Z" }
    expect(reclassifyIfPastSchedule(status, now)).toEqual(status)
  })

  it("leaves live and offline statuses untouched", () => {
    const now = new Date("2026-09-09T12:00:00.000Z")
    const live: CreatorStatus = { kind: "live", videoId: "v1", title: "t" }
    const offline: CreatorStatus = { kind: "offline" }
    expect(reclassifyIfPastSchedule(live, now)).toEqual(live)
    expect(reclassifyIfPastSchedule(offline, now)).toEqual(offline)
  })
})

describe("formatCreatorStatus", () => {
  const now = new Date("2026-09-09T12:00:00.000Z")

  it("renders live as a clickable red LIVE label", () => {
    const status: CreatorStatus = { kind: "live", videoId: "v1", title: "t" }
    expect(formatCreatorStatus(status, "absolute", now)).toEqual({ label: "LIVE", dotColor: "red", clickable: true })
  })

  it("renders offline as a non-clickable grey OFFLINE label — same for 'no schedule' and 'just ended'", () => {
    const status: CreatorStatus = { kind: "offline" }
    expect(formatCreatorStatus(status, "absolute", now)).toEqual({ label: "OFFLINE", dotColor: "grey", clickable: false })
    expect(formatCreatorStatus(status, "countdown", now)).toEqual({ label: "OFFLINE", dotColor: "grey", clickable: false })
  })

  it("renders upcoming in absolute mode using local HH:mm", () => {
    const status: CreatorStatus = { kind: "upcoming", videoId: "v1", title: "t", scheduledStart: new Date(2026, 8, 9, 15, 30).toISOString() }
    expect(formatCreatorStatus(status, "absolute", now)).toEqual({ label: "15:30", dotColor: "red", clickable: true })
  })

  it("renders upcoming in countdown mode using an hours-minutes-later pattern", () => {
    const status: CreatorStatus = { kind: "upcoming", videoId: "v1", title: "t", scheduledStart: "2026-09-09T13:15:00.000Z" }
    expect(formatCreatorStatus(status, "countdown", now)).toEqual({ label: "1時間15分後", dotColor: "red", clickable: true })
  })
})
