import { describe, expect, it } from "vitest"
import type { Locale } from "../../../shared/i18n/translations"
import { t } from "../../../shared/i18n/translations"
import { englishOrdinal, formatAnniversaryLabel, formatCountdown, formatMilestoneDate } from "./milestoneFormat"

const SAMPLE = { months: 3, days: 12, hours: 8, minutes: 5, seconds: 9 }

describe("englishOrdinal", () => {
  it.each([
    [1, "1st"], [2, "2nd"], [3, "3rd"], [4, "4th"], [9, "9th"], [10, "10th"],
    [11, "11th"], [12, "12th"], [13, "13th"], [14, "14th"],
    [21, "21st"], [22, "22nd"], [23, "23rd"], [24, "24th"],
    [101, "101st"], [111, "111th"], [112, "112th"], [113, "113th"], [121, "121st"],
  ])("%i -> %s", (value, expected) => {
    expect(englishOrdinal(value)).toBe(expected)
  })
})

describe("countdown text: zero months/days/hours are hidden, minutes and seconds always shown, a single space between, no zero padding", () => {
  it("Japanese", () => expect(formatCountdown("ja", SAMPLE)).toBe("3ヶ月 12日 8時間 5分 9秒"))
  it("English", () => expect(formatCountdown("en", SAMPLE)).toBe("3mo 12d 8h 5m 9s"))
  it("Chinese", () => expect(formatCountdown("zh-TW", SAMPLE)).toBe("3個月 12天 8小時 5分 9秒"))

  it.each([
    ["en", "0m 0s"],
    ["ja", "0分 0秒"],
    ["zh-TW", "0分 0秒"],
  ] as const)("%s: zero remaining reads %s", (locale, expected) => {
    expect(formatCountdown(locale, { months: 0, days: 0, hours: 0, minutes: 0, seconds: 0 })).toBe(expected)
  })

  // Every combination of zero / non-zero months, days, hours and minutes/seconds (3 x 2 x 2 x 2 x 2 = 2^3 * 2^2 = 32 cases) in all three locales.
  const LABELS = {
    en: { month: "mo", day: "d", hour: "h", minute: "m", second: "s", join: "" },
    ja: { month: "ヶ月", day: "日", hour: "時間", minute: "分", second: "秒", join: "" },
    "zh-TW": { month: "個月", day: "天", hour: "小時", minute: "分", second: "秒", join: "" },
  } as const
  const cases: { months: number; days: number; hours: number; minutes: number; seconds: number }[] = []
  for (const months of [0, 3]) for (const days of [0, 12]) for (const hours of [0, 8]) for (const minutes of [0, 5]) for (const seconds of [0, 9]) cases.push({ months, days, hours, minutes, seconds })

  it.each(["en", "ja", "zh-TW"] as const)("%s: every zero/non-zero combination shows exactly the non-zero larger units plus minutes and seconds", (locale) => {
    const l = LABELS[locale]
    expect(cases).toHaveLength(32)
    for (const parts of cases) {
      const expected = [
        parts.months > 0 ? `${parts.months}${l.month}` : null,
        parts.days > 0 ? `${parts.days}${l.day}` : null,
        parts.hours > 0 ? `${parts.hours}${l.hour}` : null,
        `${parts.minutes}${l.minute}`,
        `${parts.seconds}${l.second}`,
      ].filter(Boolean).join(" ")
      expect(formatCountdown(locale, parts), JSON.stringify(parts)).toBe(expected)
    }
  })

  it.each<Locale>(["ja", "en", "zh-TW"])("%s: single spaces only, no leading zero in any combination", (locale) => {
    for (const parts of cases) {
      const text = formatCountdown(locale, parts)
      expect(text).not.toMatch(/ {2}/)
      expect(text).not.toMatch(/^ | $/)
      expect(text).not.toMatch(/(^|[^0-9])0[0-9]/)
      const pieces = text.split(" ")
      expect(pieces.length).toBeGreaterThanOrEqual(2)
      expect(pieces.length).toBeLessThanOrEqual(5)
    }
  })

  it.each([
    [{ months: 0, days: 0, hours: 0, minutes: 7, seconds: 3 }, "7m 3s"],
    [{ months: 0, days: 0, hours: 5, minutes: 0, seconds: 0 }, "5h 0m 0s"],
    [{ months: 0, days: 2, hours: 0, minutes: 0, seconds: 1 }, "2d 0m 1s"],
    [{ months: 1, days: 0, hours: 0, minutes: 0, seconds: 0 }, "1mo 0m 0s"],
    [{ months: 10, days: 5, hours: 12, minutes: 3, seconds: 7 }, "10mo 5d 12h 3m 7s"],
  ])("English examples: %j -> %s", (parts, expected) => {
    expect(formatCountdown("en", parts)).toBe(expected)
  })

  it("Japanese and Chinese zero-unit examples", () => {
    expect(formatCountdown("ja", { months: 0, days: 1, hours: 0, minutes: 0, seconds: 0 })).toBe("1日 0分 0秒")
    expect(formatCountdown("zh-TW", { months: 2, days: 0, hours: 6, minutes: 0, seconds: 4 })).toBe("2個月 6小時 0分 4秒")
  })
})
describe("calendar date: month and day, unambiguous, never padded", () => {
  it("ja and zh-TW use 月/日", () => {
    expect(formatMilestoneDate("ja", 1, 9)).toBe("1月9日")
    expect(formatMilestoneDate("zh-TW", 1, 9)).toBe("1月9日")
    expect(formatMilestoneDate("ja", 12, 31)).toBe("12月31日")
  })

  it("English uses an abbreviated month name", () => {
    expect(formatMilestoneDate("en", 1, 9)).toBe("Jan 9")
    expect(formatMilestoneDate("en", 9, 8)).toBe("Sep 8")
    expect(formatMilestoneDate("en", 2, 29)).toBe("Feb 29")
  })

  it.each<Locale>(["ja", "en", "zh-TW"])("%s: no numeric slash form and no leading zero for any month/day", (locale) => {
    for (let month = 1; month <= 12; month++) {
      for (const day of [1, 9, 10, 28]) {
        const text = formatMilestoneDate(locale, month, day)
        expect(text).not.toContain("/")
        expect(text).not.toMatch(/(^|[^0-9])0[0-9]/)
      }
    }
  })
})

describe("anniversary label", () => {
  it("Japanese: N周年記念日", () => {
    expect([1, 2, 6, 10].map((n) => formatAnniversaryLabel("ja", n))).toEqual(["1周年記念日", "2周年記念日", "6周年記念日", "10周年記念日"])
  })
  it("Chinese: N周年紀念日", () => {
    expect([1, 2, 6, 10].map((n) => formatAnniversaryLabel("zh-TW", n))).toEqual(["1周年紀念日", "2周年紀念日", "6周年紀念日", "10周年紀念日"])
  })
  it("English: ordinal + Anniversary", () => {
    expect([1, 2, 3, 6, 11, 21].map((n) => formatAnniversaryLabel("en", n))).toEqual([
      "1st Anniversary", "2nd Anniversary", "3rd Anniversary", "6th Anniversary", "11th Anniversary", "21st Anniversary",
    ])
  })
})

describe("Today and the timezone caption in every locale", () => {
  it("the celebration-day label", () => {
    expect(t("ja", "oshiStatus.milestones.today")).toBe("当日")
    expect(t("zh-TW", "oshiStatus.milestones.today")).toBe("當日")
    expect(t("en", "oshiStatus.milestones.today")).toBe("Today")
  })

  it("the timezone caption", () => {
    expect(t("ja", "oshiStatus.milestones.caption")).toBe("JST 00:00基準")
    expect(t("zh-TW", "oshiStatus.milestones.caption")).toBe("以 JST 00:00 為準")
    expect(t("en", "oshiStatus.milestones.caption")).toBe("Based on JST 00:00")
  })
})

describe("the Birthday label in every locale", () => {
  it("is 誕生日 / Birthday / 生日", () => {
    expect(t("ja", "oshiStatus.milestones.birthday")).toBe("誕生日")
    expect(t("en", "oshiStatus.milestones.birthday")).toBe("Birthday")
    expect(t("zh-TW", "oshiStatus.milestones.birthday")).toBe("生日")
  })

  it("has a text for every milestone key in all three locales", () => {
    const keys = [
      "oshiStatus.milestones.open", "oshiStatus.milestones.dialogLabel", "oshiStatus.milestones.birthday", "oshiStatus.milestones.anniversary",
      "oshiStatus.milestones.anniversaryUnknown", "oshiStatus.milestones.date", "oshiStatus.milestones.unavailable", "oshiStatus.milestones.loading", "oshiStatus.milestones.today", "oshiStatus.milestones.caption",
      "oshiStatus.milestones.unit.month", "oshiStatus.milestones.unit.day", "oshiStatus.milestones.unit.hour", "oshiStatus.milestones.unit.minute",
      "oshiStatus.milestones.unit.second",
    ] as const
    for (const locale of ["ja", "en", "zh-TW"] as const) for (const key of keys) expect(t(locale, key).length, `${locale} ${key}`).toBeGreaterThan(0)
  })
})