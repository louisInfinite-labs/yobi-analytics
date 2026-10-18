import { t, type Locale } from "../../../shared/i18n/translations"
import type { CountdownParts } from "./milestoneCountdown"

const ENGLISH_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th ... 21st: 11-13 always take "th", otherwise the last digit decides. */
export function englishOrdinal(value: number): string {
  const lastTwo = value % 100
  if (lastTwo >= 11 && lastTwo <= 13) return `${value}th`
  switch (value % 10) {
    case 1:
      return `${value}st`
    case 2:
      return `${value}nd`
    case 3:
      return `${value}rd`
    default:
      return `${value}th`
  }
}

/** "1月9日" (ja, zh-TW) or "Jan 9" (en): never a numeric 1/9 form, never zero-padded. */
export function formatMilestoneDate(locale: Locale, month: number, day: number): string {
  return t(locale, "oshiStatus.milestones.date", { month: locale === "en" ? ENGLISH_MONTHS[month - 1] : String(month), day: String(day) })
}

/** The anniversary row label: "9周年記念日" / "9th Anniversary" / "9周年紀念日". */
export function formatAnniversaryLabel(locale: Locale, number: number): string {
  return t(locale, "oshiStatus.milestones.anniversary", { ordinal: locale === "en" ? englishOrdinal(number) : String(number) })
}

/** The remaining time as plain integers with their unit attached, joined by a single space: "3mo 12d 8h 5m 9s". Months, days and hours are hidden
 * when they are 0; minutes and seconds are always shown, so zero remaining reads "0m 0s" (en) / "0分 0秒" (ja, zh-TW). No number is zero padded. */
export function formatCountdown(locale: Locale, parts: CountdownParts): string {
  const unit = (key: "month" | "day" | "hour" | "minute" | "second") => t(locale, `oshiStatus.milestones.unit.${key}`)
  const shown: string[] = []
  if (parts.months > 0) shown.push(`${parts.months}${unit("month")}`)
  if (parts.days > 0) shown.push(`${parts.days}${unit("day")}`)
  if (parts.hours > 0) shown.push(`${parts.hours}${unit("hour")}`)
  shown.push(`${parts.minutes}${unit("minute")}`, `${parts.seconds}${unit("second")}`)
  return shown.join(" ")
}