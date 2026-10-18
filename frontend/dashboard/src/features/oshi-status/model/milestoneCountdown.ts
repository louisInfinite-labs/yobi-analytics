/** Creator milestone countdowns (birthday / debut anniversary), computed entirely in Asia/Tokyo.
 *
 * The backend only supplies fixed dates (GET /creators/{creatorId}/milestones). Every target is 00:00:00 JST of a JST calendar date, and
 * "today" is the JST calendar date of the instant, so the visitor's time zone never changes a target or a result: nothing here reads
 * the browser's local calendar (no getHours/getDate/getTimezoneOffset). JST has no daylight saving, so a day is always exactly 24 hours
 * and the fixed +09:00 offset is exact. */

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const SECOND_MS = 1000

/** How a Feb 29 birthday (or debut date) is celebrated in a year that has no Feb 29. APPROVED V1 RULE: Feb 29 in a leap year, Feb 28 otherwise (the
 * countdown target and the whole-day "today" follow that effective day), while the displayed date stays the official Feb 29 (see NextOccurrence
 * displayMonth/displayDay). This is the one place the rule lives; the other values stay selectable only so a future decision is a one-line change:
 *  - "feb_28": Feb 28 in common years (the approved rule);
 *  - "mar_1": Mar 1 in common years;
 *  - "leap_years_only": no occurrence in common years, so the next one is the next Feb 29. */
export type Feb29Policy = "leap_years_only" | "feb_28" | "mar_1"
export const FEB_29_POLICY: Feb29Policy = "feb_28"

export interface JstWallTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** The JST calendar date and clock time of an absolute instant. */
export function jstWallTime(epochMs: number): JstWallTime {
  const shifted = new Date(epochMs + JST_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  }
}

/** The absolute instant of 00:00:00 JST on a JST calendar date. */
export function jstMidnightMs(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day) - JST_OFFSET_MS
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** A stored "MM-DD" birthday, or null when it is not a real calendar day (Feb 29 is real). */
export function parseBirthday(value: unknown): { month: number; day: number } | null {
  if (typeof value !== "string") return null
  const match = /^([0-9]{2})-([0-9]{2})$/.exec(value)
  if (!match) return null
  const month = Number(match[1])
  const day = Number(match[2])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(2000, month)) return null
  return { month, day }
}

/** A stored "YYYY-MM-DD" original debut date, or null when it is not a real calendar date. */
export function parseDebutDate(value: unknown): { year: number; month: number; day: number } | null {
  if (typeof value !== "string") return null
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
  return { year, month, day }
}

/** The effective month/day an event falls on in `year`, or null when it has no occurrence that year (a Feb 29 in a common year only under
 * "leap_years_only"). The only reader of the Feb 29 policy. */
export function occurrenceInYear(month: number, day: number, year: number, policy: Feb29Policy = FEB_29_POLICY): { month: number; day: number } | null {
  if (month === 2 && day === 29 && !isLeapYear(year)) {
    if (policy === "feb_28") return { month: 2, day: 28 }
    if (policy === "mar_1") return { month: 3, day: 1 }
    return null
  }
  return { month, day }
}

export interface NextOccurrence {
  year: number
  /** The effective celebration date (JST calendar): the target date, which for a common-year Feb 29 is Feb 28. */
  month: number
  day: number
  /** The official month/day to DISPLAY (the stored one, e.g. Feb 29), whatever the effective date is. */
  displayMonth: number
  displayDay: number
  /** 00:00:00 JST of the effective occurrence date. */
  targetMs: number
  /** True during the whole JST calendar day of the occurrence: it is happening today, so nothing is left to count. */
  isToday: boolean
}

/** The first occurrence of month/day whose JST date is today or later (and, with `afterYear`, in a year after it). Today's occurrence
 * stays "the next one" for the entire JST day and only advances once that day has ended. */
export function nextOccurrence(month: number, day: number, nowMs: number, options: { afterYear?: number; policy?: Feb29Policy } = {}): NextOccurrence | null {
  const today = jstWallTime(nowMs)
  const startYear = Math.max(today.year, (options.afterYear ?? -Infinity) + 1)
  // 8 years covers the longest gap between two Feb 29s (2096 -> 2104).
  for (let year = startYear; year <= startYear + 8; year++) {
    const occurrence = occurrenceInYear(month, day, year, options.policy)
    if (!occurrence) continue
    const isToday = year === today.year && occurrence.month === today.month && occurrence.day === today.day
    const isLater = year > today.year || occurrence.month > today.month || (occurrence.month === today.month && occurrence.day >= today.day)
    if (isToday || isLater) {
      return {
        year,
        month: occurrence.month,
        day: occurrence.day,
        displayMonth: month,
        displayDay: day,
        targetMs: jstMidnightMs(year, occurrence.month, occurrence.day),
        isToday,
      }
    }
  }
  return null
}

export interface CountdownParts {
  months: number
  days: number
  hours: number
  minutes: number
  seconds: number
}

const ZERO_COUNTDOWN: CountdownParts = { months: 0, days: 0, hours: 0, minutes: 0, seconds: 0 }

function wallToMs(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  return Date.UTC(year, month - 1, day, hour, minute, second)
}

/** Whole calendar months, then days/hours/minutes/seconds, from `nowMs` to `targetMs` (never negative; zeros once it has passed).
 * Months are real calendar months added to the JST wall-clock now, with the day clamped to the end of a shorter month (Jan 31 + 1 month =
 * Feb 28/29), so month lengths, year changes and leap years are exact; the remainder is exact elapsed time (days are 24 h in JST). It reads
 * only the two absolute timestamps, so it carries no timer drift. */
export function countdownBetween(nowMs: number, targetMs: number): CountdownParts {
  if (targetMs <= nowMs) return ZERO_COUNTDOWN
  const now = jstWallTime(nowMs)
  const target = jstWallTime(targetMs)
  const targetWall = wallToMs(target.year, target.month, target.day, target.hour, target.minute, target.second)

  const addMonths = (months: number): number => {
    const index = now.year * 12 + (now.month - 1) + months
    const year = Math.floor(index / 12)
    const month = (index % 12) + 1
    return wallToMs(year, month, Math.min(now.day, daysInMonth(year, month)), now.hour, now.minute, now.second)
  }

  let months = (target.year - now.year) * 12 + (target.month - now.month)
  while (months > 0 && addMonths(months) > targetWall) months--
  let remainder = targetWall - addMonths(months)
  const days = Math.floor(remainder / DAY_MS)
  remainder -= days * DAY_MS
  const hours = Math.floor(remainder / HOUR_MS)
  remainder -= hours * HOUR_MS
  const minutes = Math.floor(remainder / MINUTE_MS)
  remainder -= minutes * MINUTE_MS
  return { months, days, hours, minutes, seconds: Math.floor(remainder / SECOND_MS) }
}

export interface MilestoneCountdown {
  /** The official month/day for the date column (a Feb 29 birthday still reads Feb 29 when it is celebrated on Feb 28). */
  month: number
  day: number
  countdown: CountdownParts
  isToday: boolean
}

export type BirthdayMilestone = MilestoneCountdown

export interface AnniversaryMilestone extends MilestoneCountdown {
  /** Which anniversary the next one is (1 for the first anniversary of the original debut year). */
  number: number
}

function toMilestone(occurrence: NextOccurrence, nowMs: number): MilestoneCountdown {
  return {
    month: occurrence.displayMonth,
    day: occurrence.displayDay,
    countdown: occurrence.isToday ? ZERO_COUNTDOWN : countdownBetween(nowMs, occurrence.targetMs),
    isToday: occurrence.isToday,
  }
}

/** The next birthday from the stored "MM-DD", or null when the value is unusable (nothing is invented). */
export function birthdayMilestone(birthday: unknown, nowMs: number): BirthdayMilestone | null {
  const parsed = parseBirthday(birthday)
  if (!parsed) return null
  const occurrence = nextOccurrence(parsed.month, parsed.day, nowMs)
  return occurrence ? toMilestone(occurrence, nowMs) : null
}

/** The next debut anniversary from the ORIGINAL full debut date (a graduated creator keeps it), numbered from the original debut year. */
export function anniversaryMilestone(debutDate: unknown, nowMs: number): AnniversaryMilestone | null {
  const parsed = parseDebutDate(debutDate)
  if (!parsed) return null
  const occurrence = nextOccurrence(parsed.month, parsed.day, nowMs, { afterYear: parsed.year })
  return occurrence ? { ...toMilestone(occurrence, nowMs), number: occurrence.year - parsed.year } : null
}