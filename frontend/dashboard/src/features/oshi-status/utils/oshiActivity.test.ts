import { describe, expect, it } from "vitest"
import { isUnseenActivity } from "./oshiActivity"

describe("isUnseenActivity", () => {
  const now = new Date("2026-09-10T12:00:00Z")
  const previousVisit = new Date("2026-09-09T12:00:00Z")

  it("is false on a first visit (no previous visit to compare against)", () => {
    expect(isUnseenActivity("2026-09-10T00:00:00Z", null, now)).toBe(false)
  })

  it("is true when published strictly after the previous visit", () => {
    expect(isUnseenActivity("2026-09-09T13:00:00Z", previousVisit, now)).toBe(true)
  })

  it("is false when published exactly at the previous visit (exclusive boundary)", () => {
    expect(isUnseenActivity(previousVisit.toISOString(), previousVisit, now)).toBe(false)
  })

  it("is false when published before the previous visit", () => {
    expect(isUnseenActivity("2026-09-01T00:00:00Z", previousVisit, now)).toBe(false)
  })

  it("is true when published exactly at now (inclusive boundary)", () => {
    expect(isUnseenActivity(now.toISOString(), previousVisit, now)).toBe(true)
  })

  it("is false when published after now (would only happen for bad data)", () => {
    expect(isUnseenActivity("2026-09-11T00:00:00Z", previousVisit, now)).toBe(false)
  })

  it("is false for an unparseable publishedAt", () => {
    expect(isUnseenActivity("not-a-date", previousVisit, now)).toBe(false)
  })
})
