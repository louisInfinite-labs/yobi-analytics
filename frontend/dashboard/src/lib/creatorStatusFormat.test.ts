import { describe, expect, it } from "vitest"
import {
  formatAbsoluteTime,
  formatCountdown,
  formatCreatorStatus,
  isScheduledTimeReached,
  reclassifyIfPastSchedule,
} from "./creatorStatusFormat"
import type { CreatorStatus } from "../types/creatorStatus"

describe("formatCountdown", () => {
  it("floors partial minutes rather than rounding", () => {
    const now = new Date("2026-09-09T00:00:00.000Z")
    // 65 minutes 59 seconds away — must read 1時間5分後, not 1時間6分後.
    const target = new Date(now.getTime() + 65 * 60_000 + 59_000).toISOString()
    expect(formatCountdown(target, now)).toBe("1時間5分後")
  })

  it("never shows a negative value once the target time has passed", () => {
    const now = new Date("2026-09-09T12:00:00.000Z")
    const target = new Date("2026-09-09T11:00:00.000Z").toISOString()
    expect(formatCountdown(target, now)).toBe("0時間0分後")
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

  it("renders Chinese as X小時X分後", () => {
    const now = new Date("2026-09-09T00:00:00.000Z")
    const target = new Date("2026-09-09T01:05:00.000Z").toISOString()
    expect(formatCountdown(target, now, "zh")).toBe("1小時5分後")
  })

  it("renders English as In Xh:Xm", () => {
    const now = new Date("2026-09-09T00:00:00.000Z")
    const target = new Date("2026-09-09T01:05:00.000Z").toISOString()
    expect(formatCountdown(target, now, "en")).toBe("In 1h:5m")
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

  it("renders upcoming in countdown mode using X時間X分後", () => {
    const status: CreatorStatus = { kind: "upcoming", videoId: "v1", title: "t", scheduledStart: "2026-09-09T13:15:00.000Z" }
    expect(formatCreatorStatus(status, "countdown", now)).toEqual({ label: "1時間15分後", dotColor: "red", clickable: true })
  })
})
