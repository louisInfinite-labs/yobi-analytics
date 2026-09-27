import { describe, expect, it } from "vitest"
import { shouldShowLiveBadge } from "./scheduledStream"

const NOW = new Date("2026-09-26T12:00:00+09:00").getTime()

describe("shouldShowLiveBadge", () => {
  it("shows for a currently-live stream regardless of scheduledStart", () => {
    expect(shouldShowLiveBadge("live", NOW - 999_999, NOW)).toBe(true)
  })

  it("shows for an upcoming stream starting within 60 minutes", () => {
    expect(shouldShowLiveBadge("upcoming", NOW + 30 * 60_000, NOW)).toBe(true)
    expect(shouldShowLiveBadge("upcoming", NOW + 60 * 60_000, NOW)).toBe(true)
  })

  it("does not show for an upcoming stream starting more than 60 minutes out", () => {
    expect(shouldShowLiveBadge("upcoming", NOW + 61 * 60_000, NOW)).toBe(false)
  })

  it("does not show for an upcoming stream whose start already passed (reclassification's job, not this check's)", () => {
    expect(shouldShowLiveBadge("upcoming", NOW - 1, NOW)).toBe(false)
  })

  it("never shows for an ended stream", () => {
    expect(shouldShowLiveBadge("ended", NOW - 999_999, NOW)).toBe(false)
  })
})
