import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { computeTodayIndicators, milestoneIndicatorKind, milestoneIndicatorText, todayMilestoneEvents } from "./milestoneToday"

/** An absolute instant from JST wall-clock fields. */
const jst = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) => Date.UTC(year, month - 1, day, hour, minute, second) - 9 * 3600 * 1000

// The real 110-creator production dataset (merged in scripts/migration), the same dates the Live Status list reads from the bulk endpoint.
const SEED = JSON.parse(readFileSync(resolve(process.cwd(), "../../scripts/migration/creator_milestones_seed.json"), "utf8")).records as {
  creatorId: string
  birthday: string
  debutDate: string
}[]
const ALL = Object.fromEntries(SEED.map((r) => [r.creatorId, { birthday: r.birthday, debutDate: r.debutDate }]))
const SUISEI = ALL.hoshimachi_suisei

describe("today events for one creator", () => {
  it("birthday only", () => {
    expect(todayMilestoneEvents(ALL.kaga_nazuna, jst(2027, 4, 2, 9))).toEqual({ birthday: true, debut: false })
    expect(milestoneIndicatorKind({ birthday: true, debut: false })).toBe("birthday")
  })

  it("debut anniversary only, using the ORIGINAL debut date of a graduated creator", () => {
    // Kiryu Coco graduated in 2021 but keeps 2019-12-28: her debut anniversary is still celebrated on Dec 28.
    expect(ALL.kiryu_coco.debutDate).toBe("2019-12-28")
    expect(todayMilestoneEvents(ALL.kiryu_coco, jst(2026, 12, 28, 12))).toEqual({ birthday: false, debut: true })
    expect(milestoneIndicatorKind({ birthday: false, debut: true })).toBe("debut")
  })

  it("Hoshimachi Suisei on March 22 JST: birthday AND debut anniversary together", () => {
    expect(SUISEI).toEqual({ birthday: "03-22", debutDate: "2018-03-22" })
    const events = todayMilestoneEvents(SUISEI, jst(2027, 3, 22, 15))
    expect(events).toEqual({ birthday: true, debut: true })
    expect(milestoneIndicatorKind(events)).toBe("both")
  })

  it("an ordinary day has no indicator", () => {
    expect(milestoneIndicatorKind(todayMilestoneEvents(SUISEI, jst(2027, 3, 21, 12)))).toBeNull()
    expect(milestoneIndicatorKind(todayMilestoneEvents(SUISEI, jst(2027, 3, 23, 12)))).toBeNull()
  })

  it("the debut day itself in the debut year is not an anniversary, but the next year is", () => {
    expect(todayMilestoneEvents({ birthday: "01-01", debutDate: "2026-10-18" }, jst(2026, 10, 18, 12)).debut).toBe(false)
    expect(todayMilestoneEvents({ birthday: "01-01", debutDate: "2026-10-18" }, jst(2027, 10, 18, 12)).debut).toBe(true)
  })
})

describe("JST midnight transitions", () => {
  it("one second before midnight: nothing yet; exactly midnight: starts; whole day: stays; next midnight: gone", () => {
    expect(milestoneIndicatorKind(todayMilestoneEvents(SUISEI, jst(2027, 3, 21, 23, 59, 59)))).toBeNull()
    expect(milestoneIndicatorKind(todayMilestoneEvents(SUISEI, jst(2027, 3, 22, 0, 0, 0)))).toBe("both")
    expect(milestoneIndicatorKind(todayMilestoneEvents(SUISEI, jst(2027, 3, 22, 12, 0, 0)))).toBe("both")
    expect(milestoneIndicatorKind(todayMilestoneEvents(SUISEI, jst(2027, 3, 22, 23, 59, 59)))).toBe("both")
    expect(milestoneIndicatorKind(todayMilestoneEvents(SUISEI, jst(2027, 3, 23, 0, 0, 0)))).toBeNull()
  })

  describe("browser time zone independence", () => {
    const originalTz = process.env.TZ
    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ
      else process.env.TZ = originalTz
    })

    it("the same instants give the same answers in every zone", () => {
      const offsets = new Set<number>()
      for (const zone of ["Asia/Tokyo", "Asia/Hong_Kong", "America/Los_Angeles", "Europe/London", "Pacific/Auckland"]) {
        process.env.TZ = zone
        offsets.add(new Date(Date.UTC(2027, 2, 21, 15, 0, 0)).getTimezoneOffset())
        // 2027-03-21 15:00 UTC is 2027-03-22 00:00 JST.
        expect(milestoneIndicatorKind(todayMilestoneEvents(SUISEI, Date.UTC(2027, 2, 21, 15, 0, 0))), zone).toBe("both")
        expect(milestoneIndicatorKind(todayMilestoneEvents(SUISEI, Date.UTC(2027, 2, 21, 14, 59, 59))), zone).toBeNull()
        expect(milestoneIndicatorKind(todayMilestoneEvents(SUISEI, Date.UTC(2027, 2, 22, 14, 59, 59))), zone).toBe("both")
        expect(milestoneIndicatorKind(todayMilestoneEvents(SUISEI, Date.UTC(2027, 2, 22, 15, 0, 0))), zone).toBeNull()
      }
      expect(offsets.size).toBeGreaterThan(2)
    })
  })
})

describe("Feb 29 follows the approved rule", () => {
  const baelz = ALL.hakos_baelz

  it("celebrated on Feb 28 in a common year and on Feb 29 in a leap year", () => {
    expect(baelz.birthday).toBe("02-29")
    expect(milestoneIndicatorKind(todayMilestoneEvents(baelz, jst(2027, 2, 28, 10)))).toBe("birthday")
    expect(milestoneIndicatorKind(todayMilestoneEvents(baelz, jst(2027, 3, 1, 10)))).toBeNull()
    expect(milestoneIndicatorKind(todayMilestoneEvents(baelz, jst(2028, 2, 28, 10)))).toBeNull()
    expect(milestoneIndicatorKind(todayMilestoneEvents(baelz, jst(2028, 2, 29, 10)))).toBe("birthday")
  })
})

describe("the whole roster over two full calendar years matches an independent oracle", () => {
  /** An independent re-statement of the rule: month/day equal (Feb 29 -> Feb 28 in common years), and for debut a year strictly after the debut year. */
  function oracle(year: number, month: number, day: number) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    const expected: Record<string, string> = {}
    for (const [creatorId, m] of Object.entries(ALL)) {
      let [bm, bd] = m.birthday.split("-").map(Number)
      if (bm === 2 && bd === 29 && !leap) bd = 28
      const [dy, dm, dd] = m.debutDate.split("-").map(Number)
      const birthday = bm === month && bd === day
      const debut = dm === month && dd === day && year > dy
      if (birthday || debut) expected[creatorId] = birthday && debut ? "both" : birthday ? "birthday" : "debut"
    }
    return expected
  }

  it("2027 (common) and 2028 (leap), every day", () => {
    let withEvents = 0
    for (const year of [2027, 2028]) {
      for (let dayOfYear = 0; dayOfYear < (year === 2028 ? 366 : 365); dayOfYear++) {
        const date = new Date(Date.UTC(year, 0, 1 + dayOfYear))
        const [m, d] = [date.getUTCMonth() + 1, date.getUTCDate()]
        const expected = oracle(year, m, d)
        expect(computeTodayIndicators(ALL, jst(year, m, d, 0, 0, 0)), `${year}-${m}-${d} 00:00`).toEqual(expected)
        expect(computeTodayIndicators(ALL, jst(year, m, d, 23, 59, 59)), `${year}-${m}-${d} 23:59:59`).toEqual(expected)
        withEvents += Object.keys(expected).length
      }
    }
    expect(withEvents).toBeGreaterThan(300)
  })

  it("March 22 2027 shows exactly Hoshimachi Suisei, once, as both", () => {
    expect(computeTodayIndicators(ALL, jst(2027, 3, 22, 12))).toEqual({ hoshimachi_suisei: "both" })
  })

  it("active and graduated creators are both included", () => {
    expect(Object.keys(ALL)).toContain("mano_aloe")
    expect(computeTodayIndicators(ALL, jst(2027, 10, 28, 9)).mano_aloe).toBe("birthday")
    expect(computeTodayIndicators(ALL, jst(2027, 8, 15, 9)).mano_aloe).toBe("debut")
  })
})

describe("the inline text: event label, one space, Today once", () => {
  it.each([
    ["zh-TW", "birthday", "生日 當日"],
    ["zh-TW", "debut", "出道日 當日"],
    ["zh-TW", "both", "生日&出道日 當日"],
    ["ja", "birthday", "誕生日 当日"],
    ["ja", "debut", "デビュー日 当日"],
    ["ja", "both", "誕生日&デビュー日 当日"],
    ["en", "birthday", "Birthday Today"],
    ["en", "debut", "Debut Today"],
    ["en", "both", "Birthday & Debut Today"],
  ] as const)("%s %s -> %s", (locale, kind, expected) => {
    expect(milestoneIndicatorText(locale, kind)).toBe(expected)
  })

  it("a combined event never repeats the Today label", () => {
    for (const locale of ["zh-TW", "ja", "en"] as const) {
      const text = milestoneIndicatorText(locale, "both")
      const today = { "zh-TW": "當日", ja: "当日", en: "Today" }[locale]
      expect(text.split(today).length - 1).toBe(1)
    }
  })
})