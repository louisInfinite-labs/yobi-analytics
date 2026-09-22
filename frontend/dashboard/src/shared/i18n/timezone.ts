/** Detect the viewer's device IANA time zone (dashboard_ui_direction_en.md's
 * Time-Zone Request Contract) — falls back to UTC, never silently assumes Tokyo. */
export function detectDeviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/** Milliseconds until the next occurrence of `hour` in the device's local
 * zone. Recomputing after every firing lets the browser apply DST changes. */
export function millisecondsUntilNextLocalHour(hour: number, now = new Date()): number {
  const next = new Date(now)
  next.setHours(hour, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

/** Backend report partitions are currently published under Tokyo calendar
 * dates, even when the viewer's presentation time zone is different. */
export function dateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ""
  return `${value("year")}-${value("month")}-${value("day")}`
}
