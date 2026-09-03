/** Compact human-readable number, e.g. 128400 -> "128.4K", 2150000 -> "2.15M". */
export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value)
}

/** Full grouped number, e.g. 128400 -> "128,400". */
export function formatFullNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value)
}

/** Signed percent with one decimal, e.g. 24.567 -> "+24.6%", -1.3 -> "-1.3%". */
export function formatSignedPercent(value: number): string {
  const sign = value > 0 ? "+" : ""
  return `${sign}${value.toFixed(1)}%`
}

/** Signed compact count, e.g. 24300 -> "+24.3K", -1200 -> "-1.2K". */
export function formatSignedCompactNumber(value: number): string {
  const sign = value > 0 ? "+" : ""
  return `${sign}${formatCompactNumber(value)}`
}

/** Render an ISO timestamp in the given IANA time zone, e.g. "Sep 3, 18:00". */
export function formatTimeInZone(isoTimestamp: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(isoTimestamp))
}
