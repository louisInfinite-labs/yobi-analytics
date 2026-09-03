import { describe, expect, it } from "vitest"
import { formatTimeInZone } from "./format"

describe("formatTimeInZone", () => {
  it("uses a 24-hour clock, not en-US's default 12-hour AM/PM", () => {
    // 2026-09-03T09:00:00Z is 18:00 in Asia/Tokyo (UTC+9) — an evening
    // timestamp specifically chosen to catch a 12-hour "06:00 PM" regression.
    const formatted = formatTimeInZone("2026-09-03T09:00:00Z", "Asia/Tokyo")
    expect(formatted).toContain("18:00")
    expect(formatted).not.toMatch(/AM|PM/i)
  })
})
