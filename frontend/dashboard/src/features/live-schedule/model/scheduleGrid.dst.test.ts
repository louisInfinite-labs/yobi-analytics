import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SLOT_COUNT, slotIndexForMs } from "./scheduleGrid"

// Node re-reads TZ on assignment to process.env, and Vitest gives each test file
// its own process, so setting it here changes what `new Date(...).getHours()`
// etc. mean for this file only. The guard test below fails loudly if the
// override didn't take effect, instead of silently testing the machine's own zone.
// The app tsconfig deliberately has no Node types (production code shouldn't
// see Node globals), so type just the one global this test needs.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
const originalTz = env.TZ

interface DstZone {
  tz: string
  summerOffsetMinutes: number
  springForward: [number, number, number]
  fallBack: [number, number, number]
  /** Two real instants (UTC ms) that read as the same repeated local time on the fall-back day. */
  repeated: { first: number; second: number; row: number }
}

const ZONES: DstZone[] = [
  {
    tz: "America/Los_Angeles",
    summerOffsetMinutes: 420,
    springForward: [2026, 2, 8],
    fallBack: [2026, 10, 1],
    // 01:30 PDT then 01:30 PST
    repeated: { first: Date.UTC(2026, 10, 1, 8, 30), second: Date.UTC(2026, 10, 1, 9, 30), row: 3 },
  },
  {
    tz: "Europe/Berlin",
    summerOffsetMinutes: -120,
    springForward: [2026, 2, 29],
    fallBack: [2026, 9, 25],
    // 02:30 CEST then 02:30 CET
    repeated: { first: Date.UTC(2026, 9, 25, 0, 30), second: Date.UTC(2026, 9, 25, 1, 30), row: 5 },
  },
]

/** Wall-clock hour/minute/date of `ms` in `tz`, read independently of process.env.TZ. */
function wallClockIn(tz: string, ms: number) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms))
  const get = (type: string) => Number(parts.find((part) => part.type === type)!.value)
  return { year: get("year"), month: get("month") - 1, date: get("day"), hour: get("hour"), minute: get("minute") }
}

describe.each(ZONES)("slotIndexForMs on DST days in $tz", (zone) => {
  beforeAll(() => {
    env.TZ = zone.tz
  })
  afterAll(() => {
    if (originalTz === undefined) delete env.TZ
    else env.TZ = originalTz
  })

  it("is actually running in the requested timezone", () => {
    expect(new Date(2026, 6, 1, 12).getTimezoneOffset()).toBe(zone.summerOffsetMinutes)
  })

  it("spring-forward: a local 03:30 timestamp maps to the 03:30 row, not 04:30", () => {
    const [y, m, d] = zone.springForward
    const day = new Date(y, m, d)
    expect(slotIndexForMs(new Date(y, m, d, 0, 0).getTime(), day)).toBe(0)
    expect(slotIndexForMs(new Date(y, m, d, 1, 30).getTime(), day)).toBe(3)
    expect(slotIndexForMs(new Date(y, m, d, 3, 30).getTime(), day)).toBe(7)
    expect(slotIndexForMs(new Date(y, m, d, 23, 30).getTime(), day)).toBe(SLOT_COUNT - 1)
  })

  it("fall-back: both occurrences of the repeated wall-clock time land on the matching row", () => {
    const [y, m, d] = zone.fallBack
    const day = new Date(y, m, d)
    const { first, second, row } = zone.repeated
    expect(wallClockIn(zone.tz, first)).toMatchObject({ hour: wallClockIn(zone.tz, second).hour, minute: 30 })
    expect(slotIndexForMs(first, day)).toBe(row)
    expect(slotIndexForMs(second, day)).toBe(row)
  })

  it("fall-back: a late-night stream on the 25-hour day is not dropped", () => {
    const [y, m, d] = zone.fallBack
    const day = new Date(y, m, d)
    expect(slotIndexForMs(new Date(y, m, d, 22, 0).getTime(), day)).toBe(44)
    expect(slotIndexForMs(new Date(y, m, d, 23, 30).getTime(), day)).toBe(SLOT_COUNT - 1)
  })

  it.each([
    ["spring-forward", zone.springForward],
    ["fall-back", zone.fallBack],
  ] as const)("%s: every real half-hour instant maps to its own wall-clock row, and neighbouring days to null", (_label, [y, m, d]) => {
    const day = new Date(y, m, d)
    const midnight = new Date(y, m, d).getTime()
    const HALF_HOUR = 30 * 60_000
    // From an hour before local midnight to an hour past the longest (25h) day.
    for (let ms = midnight - 2 * HALF_HOUR; ms <= midnight + 27 * 2 * HALF_HOUR; ms += HALF_HOUR) {
      const wall = wallClockIn(zone.tz, ms)
      const onDay = wall.year === y && wall.month === m && wall.date === d
      const expected = onDay ? wall.hour * 2 + Math.floor(wall.minute / 30) : null
      expect(slotIndexForMs(ms, day), `${new Date(ms).toISOString()} (${wall.hour}:${wall.minute})`).toBe(expected)
    }
  })
})
