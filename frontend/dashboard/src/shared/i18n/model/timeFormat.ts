export type TimeFormat = "24h" | "12h"

/** Formats a Date's local clock time per the user's global time format. */
export function formatClockTime(date: Date, timeFormat: TimeFormat = "24h"): string {
  const hours = date.getHours()
  const minutes = String(date.getMinutes()).padStart(2, "0")
  if (timeFormat === "12h") return `${hours % 12 || 12}:${minutes} ${hours < 12 ? "AM" : "PM"}`
  return `${String(hours).padStart(2, "0")}:${minutes}`
}
