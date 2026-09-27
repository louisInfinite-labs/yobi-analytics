import { describe, expect, it } from "vitest"
import { formatClockTime } from "./timeFormat"

describe("formatClockTime", () => {
  it("formats 24-hour HH:mm by default", () => {
    expect(formatClockTime(new Date(2026, 0, 1, 9, 30))).toBe("09:30")
    expect(formatClockTime(new Date(2026, 0, 1, 18, 45), "24h")).toBe("18:45")
  })

  it("formats 12-hour AM/PM including midnight and noon", () => {
    expect(formatClockTime(new Date(2026, 0, 1, 9, 30), "12h")).toBe("9:30 AM")
    expect(formatClockTime(new Date(2026, 0, 1, 18, 45), "12h")).toBe("6:45 PM")
    expect(formatClockTime(new Date(2026, 0, 1, 0, 5), "12h")).toBe("12:05 AM")
    expect(formatClockTime(new Date(2026, 0, 1, 12, 0), "12h")).toBe("12:00 PM")
  })
})
