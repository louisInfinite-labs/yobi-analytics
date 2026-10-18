import { afterEach, describe, expect, it } from "vitest"
import {
  anniversaryMilestone,
  birthdayMilestone,
  countdownBetween,
  FEB_29_POLICY,
  jstMidnightMs,
  jstWallTime,
  nextOccurrence,
} from "./milestoneCountdown"

/** An absolute instant from JST wall-clock fields. */
const jst = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) => Date.UTC(year, month - 1, day, hour, minute, second) - 9 * 3600 * 1000
const parts = (months: number, days: number, hours: number, minutes: number, seconds: number) => ({ months, days, hours, minutes, seconds })

describe("JST midnight, whatever the browser time zone", () => {
  const originalTz = process.env.TZ
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
  })

  it("is 3 hours away at 21:00 JST (20:00 in Hong Kong) in every zone", () => {
    const now = jst(2026, 3, 21, 21, 0, 0)
    const offsets = new Set<number>()
    for (const zone of ["Asia/Tokyo", "Asia/Hong_Kong", "America/Los_Angeles", "Europe/London", "Pacific/Auckland"]) {
      process.env.TZ = zone
      offsets.add(new Date(now).getTimezoneOffset())
      expect(birthdayMilestone("03-22", now)?.countdown, zone).toEqual(parts(0, 0, 3, 0, 0))
      expect(anniversaryMilestone("2018-03-22", now)?.countdown, zone).toEqual(parts(0, 0, 3, 0, 0))
    }
    // The zone switch really took effect (the sanity check that this test could have failed).
    expect(offsets.size).toBeGreaterThan(2)
  })

  it("targets exactly 00:00:00 +09:00 of the JST calendar date", () => {
    expect(jstMidnightMs(2027, 3, 22)).toBe(Date.parse("2027-03-22T00:00:00+09:00"))
    expect(nextOccurrence(3, 22, jst(2026, 10, 18, 12))?.targetMs).toBe(Date.parse("2027-03-22T00:00:00+09:00"))
  })

  it("reads the JST calendar date, not the browser one, around the date line", () => {
    process.env.TZ = "America/Los_Angeles"
    // 2026-03-21 16:00 UTC is 2026-03-22 01:00 JST: already the birthday in Japan, still the 21st in Los Angeles.
    expect(jstWallTime(Date.UTC(2026, 2, 21, 16, 0, 0))).toMatchObject({ year: 2026, month: 3, day: 22, hour: 1 })
    expect(birthdayMilestone("03-22", Date.UTC(2026, 2, 21, 16, 0, 0))?.isToday).toBe(true)
  })
})

describe("birthday countdown", () => {
  it("counts down to the next occurrence at 00:00 JST", () => {
    expect(birthdayMilestone("01-09", jst(2026, 10, 18, 12))).toMatchObject({ month: 1, day: 9, isToday: false, countdown: parts(2, 21, 12, 0, 0) })
  })

  it("moves to next year once this year's birthday has passed", () => {
    expect(birthdayMilestone("03-22", jst(2026, 10, 18, 12))?.countdown).toEqual(parts(5, 3, 12, 0, 0))
  })

  it("keeps the birthday for a graduated creator (the same function, no lifecycle input)", () => {
    expect(birthdayMilestone("10-28", jst(2026, 10, 18))).toMatchObject({ month: 10, day: 28, countdown: parts(0, 10, 0, 0, 0) })
  })

  it("is today for the whole JST day, with zero remaining, then advances", () => {
    expect(birthdayMilestone("03-22", jst(2027, 3, 22, 0, 0, 0))).toMatchObject({ isToday: true, countdown: parts(0, 0, 0, 0, 0) })
    expect(birthdayMilestone("03-22", jst(2027, 3, 22, 23, 59, 59))).toMatchObject({ isToday: true, countdown: parts(0, 0, 0, 0, 0) })
    expect(birthdayMilestone("03-22", jst(2027, 3, 23, 0, 0, 0))).toMatchObject({ isToday: false, countdown: parts(11, 28, 0, 0, 0) })
  })

  it("returns null for an unusable stored value instead of inventing one", () => {
    for (const bad of ["13-01", "02-30", "1-1", "", null, undefined, 322, "03/22"]) expect(birthdayMilestone(bad, jst(2026, 1, 1))).toBeNull()
  })
})

describe("anniversary number and date", () => {
  it("numbers the next anniversary from the ORIGINAL debut year (the 2018-03-22 example is the 9th in 2027)", () => {
    expect(anniversaryMilestone("2018-03-22", jst(2026, 10, 18))).toMatchObject({ number: 9, month: 3, day: 22 })
  })

  it("uses the upcoming one this year when it has not happened yet", () => {
    expect(anniversaryMilestone("2018-10-20", jst(2026, 10, 18, 12))).toMatchObject({ number: 8, month: 10, day: 20, isToday: false })
    expect(anniversaryMilestone("2018-10-20", jst(2026, 10, 18, 12))?.countdown).toEqual(parts(0, 1, 12, 0, 0))
  })

  it("keeps the current number all anniversary day with zero remaining, and advances when the JST day ends", () => {
    expect(anniversaryMilestone("2018-03-22", jst(2027, 3, 21, 23, 59, 59))).toMatchObject({ number: 9, isToday: false, countdown: parts(0, 0, 0, 0, 1) })
    expect(anniversaryMilestone("2018-03-22", jst(2027, 3, 22, 0, 0, 0))).toMatchObject({ number: 9, isToday: true, countdown: parts(0, 0, 0, 0, 0) })
    expect(anniversaryMilestone("2018-03-22", jst(2027, 3, 22, 23, 59, 59))).toMatchObject({ number: 9, isToday: true })
    expect(anniversaryMilestone("2018-03-22", jst(2027, 3, 23, 0, 0, 0))).toMatchObject({ number: 10, isToday: false })
  })

  it("never counts the debut year itself as an anniversary", () => {
    expect(anniversaryMilestone("2030-05-05", jst(2026, 10, 18))).toMatchObject({ number: 1 })
    expect(anniversaryMilestone("2026-10-18", jst(2026, 10, 18, 5))).toMatchObject({ number: 1, month: 10, day: 18, isToday: false })
  })

  it("returns null for an unusable original debut date", () => {
    for (const bad of ["2018-02-29", "2018-13-01", "2018/03/22", "18-03-22", null, undefined]) expect(anniversaryMilestone(bad, jst(2026, 1, 1))).toBeNull()
  })
})

describe("calendar month arithmetic", () => {
  it("clamps month ends (Jan 31 + 1 month is Feb 28 in a common year)", () => {
    expect(countdownBetween(jst(2026, 1, 31), jst(2026, 3, 1))).toEqual(parts(1, 1, 0, 0, 0))
  })

  it("uses Feb 29 in a leap year and Feb 28 otherwise", () => {
    expect(countdownBetween(jst(2028, 1, 29), jst(2028, 3, 1))).toEqual(parts(1, 1, 0, 0, 0))
    expect(countdownBetween(jst(2027, 1, 29), jst(2027, 3, 1))).toEqual(parts(1, 1, 0, 0, 0))
  })

  it("uses real month lengths, not 30-day months", () => {
    // Jan 1 -> Feb 1 is 1 month (31 days); Feb 1 -> Mar 1 is 1 month (28 days).
    expect(countdownBetween(jst(2026, 1, 1), jst(2026, 2, 1))).toEqual(parts(1, 0, 0, 0, 0))
    expect(countdownBetween(jst(2026, 2, 1), jst(2026, 3, 1))).toEqual(parts(1, 0, 0, 0, 0))
    expect(countdownBetween(jst(2026, 1, 1), jst(2026, 1, 31))).toEqual(parts(0, 30, 0, 0, 0))
  })

  it("crosses a year change", () => {
    expect(countdownBetween(jst(2026, 12, 31, 23, 59, 59), jst(2027, 1, 1))).toEqual(parts(0, 0, 0, 0, 1))
    expect(countdownBetween(jst(2026, 11, 15, 6, 30, 15), jst(2027, 2, 15))).toEqual(parts(2, 30, 17, 29, 45))
  })

  it("is never negative and is zero once the target has passed", () => {
    expect(countdownBetween(jst(2026, 6, 1), jst(2026, 5, 1))).toEqual(parts(0, 0, 0, 0, 0))
    expect(countdownBetween(jst(2026, 6, 1), jst(2026, 6, 1))).toEqual(parts(0, 0, 0, 0, 0))
  })

  it("is a pure function of the two absolute timestamps: one second later is exactly one second less", () => {
    const target = jst(2027, 3, 22)
    const start = jst(2026, 10, 18, 12, 0, 0)
    expect(countdownBetween(start, target)).toEqual(parts(5, 3, 12, 0, 0))
    expect(countdownBetween(start + 1000, target)).toEqual(parts(5, 3, 11, 59, 59))
    expect(countdownBetween(start + 3_600_000, target)).toEqual(parts(5, 3, 11, 0, 0))
  })
})

describe("Feb 29 birthday: Feb 29 in leap years, Feb 28 in common years (approved V1 rule)", () => {
  it("uses the approved policy", () => {
    expect(FEB_29_POLICY).toBe("feb_28")
  })

  it("common year: counts down to Feb 28 00:00 JST but still displays the official Feb 29", () => {
    const milestone = birthdayMilestone("02-29", jst(2026, 10, 18, 12))
    expect(milestone).toMatchObject({ month: 2, day: 29, isToday: false, countdown: parts(4, 9, 12, 0, 0) })
    expect(nextOccurrence(2, 29, jst(2026, 10, 18, 12))).toMatchObject({ year: 2027, month: 2, day: 28, displayMonth: 2, displayDay: 29 })
    expect(nextOccurrence(2, 29, jst(2026, 10, 18, 12))?.targetMs).toBe(Date.parse("2027-02-28T00:00:00+09:00"))
  })

  it("leap year: counts down to Feb 29 00:00 JST", () => {
    const next = nextOccurrence(2, 29, jst(2027, 10, 18, 12))
    expect(next).toMatchObject({ year: 2028, month: 2, day: 29, displayMonth: 2, displayDay: 29 })
    expect(next?.targetMs).toBe(Date.parse("2028-02-29T00:00:00+09:00"))
    expect(birthdayMilestone("02-29", jst(2028, 2, 28, 12))).toMatchObject({ month: 2, day: 29, isToday: false, countdown: parts(0, 0, 12, 0, 0) })
  })

  it("common-year celebration day: zero remaining for the whole JST day, switching at JST midnight", () => {
    expect(birthdayMilestone("02-29", jst(2027, 2, 27, 23, 59, 59))).toMatchObject({ isToday: false, countdown: parts(0, 0, 0, 0, 1) })
    expect(birthdayMilestone("02-29", jst(2027, 2, 28, 0, 0, 0))).toMatchObject({ month: 2, day: 29, isToday: true, countdown: parts(0, 0, 0, 0, 0) })
    expect(birthdayMilestone("02-29", jst(2027, 2, 28, 23, 59, 59))).toMatchObject({ isToday: true, countdown: parts(0, 0, 0, 0, 0) })
    // Feb 29 does not exist in 2027, so March 1 is already past the celebration: the next one is the leap day of 2028.
    expect(birthdayMilestone("02-29", jst(2027, 3, 1, 0, 0, 0))).toMatchObject({ isToday: false, month: 2, day: 29, countdown: parts(11, 28, 0, 0, 0) })
  })

  it("leap-year celebration day: zero remaining for the whole JST day, Feb 28 is NOT the day, then rolls to the next year's Feb 28", () => {
    expect(birthdayMilestone("02-29", jst(2028, 2, 29, 0, 0, 0))).toMatchObject({ month: 2, day: 29, isToday: true, countdown: parts(0, 0, 0, 0, 0) })
    expect(birthdayMilestone("02-29", jst(2028, 2, 29, 23, 59, 59))).toMatchObject({ isToday: true, countdown: parts(0, 0, 0, 0, 0) })
    const after = birthdayMilestone("02-29", jst(2028, 3, 1, 0, 0, 0))
    expect(after).toMatchObject({ isToday: false, month: 2, day: 29 })
    expect(nextOccurrence(2, 29, jst(2028, 3, 1))).toMatchObject({ year: 2029, month: 2, day: 28 })
    expect(after?.countdown).toEqual(parts(11, 27, 0, 0, 0))
  })

  it("year rollover: the last seconds of the year before a common-year Feb 28 keep counting toward it", () => {
    expect(birthdayMilestone("02-29", jst(2026, 12, 31, 23, 59, 59))).toMatchObject({ isToday: false, countdown: parts(1, 27, 0, 0, 1) })
    expect(birthdayMilestone("02-29", jst(2027, 1, 1, 0, 0, 0))).toMatchObject({ isToday: false, countdown: parts(1, 27, 0, 0, 0) })
  })

  it("is judged in JST, not the browser zone, around the Feb 28 boundary", () => {
    const original = process.env.TZ
    try {
      process.env.TZ = "America/Los_Angeles"
      // 2027-02-27 15:00 UTC is 2027-02-28 00:00 JST: the celebration day has begun in Japan though it is still the 27th in Los Angeles.
      expect(birthdayMilestone("02-29", Date.UTC(2027, 1, 27, 15, 0, 0))).toMatchObject({ isToday: true, countdown: parts(0, 0, 0, 0, 0) })
      expect(birthdayMilestone("02-29", Date.UTC(2027, 1, 27, 14, 59, 59))).toMatchObject({ isToday: false, countdown: parts(0, 0, 0, 0, 1) })
    } finally {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    }
  })

  it("does not change an ordinary Feb 28 birthday", () => {
    expect(birthdayMilestone("02-28", jst(2027, 2, 28, 12))).toMatchObject({ month: 2, day: 28, isToday: true })
    expect(birthdayMilestone("02-28", jst(2028, 2, 28, 12))).toMatchObject({ month: 2, day: 28, isToday: true })
  })

  it("the alternatives stay one setting away", () => {
    expect(nextOccurrence(2, 29, jst(2026, 10, 18), { policy: "mar_1" })).toMatchObject({ year: 2027, month: 3, day: 1 })
    expect(nextOccurrence(2, 29, jst(2026, 10, 18), { policy: "leap_years_only" })).toMatchObject({ year: 2028, month: 2, day: 29 })
  })

  it("still finds the next Feb 29 across the 2100 non-leap century year when only leap years count", () => {
    expect(nextOccurrence(2, 29, jst(2097, 1, 1), { policy: "leap_years_only" })).toMatchObject({ year: 2104 })
  })
})