/** Detect the viewer's device IANA time zone (dashboard_ui_direction_en.md's
 * Time-Zone Request Contract) — falls back to UTC, never silently assumes Tokyo. */
export function detectDeviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}
