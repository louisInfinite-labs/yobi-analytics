import { useMemo, useState } from "react"

// Curated fallback for engines without Intl.supportedValuesOf (Roadmap 3.4/3.5:
// support any valid IANA zone, not a hardcoded Tokyo/Hong Kong-only allowlist —
// this is only the datalist's suggestion source, not the validation boundary;
// see isValidTimeZone below for that).
const FALLBACK_ZONES = [
  "UTC",
  "Asia/Tokyo",
  "Asia/Hong_Kong",
  "Asia/Seoul",
  "Asia/Taipei",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "Australia/Sydney",
]

/** Return every IANA zone the engine knows about, or a small curated fallback list. */
function listSupportedZones(): string[] {
  const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  try {
    return supportedValuesOf ? supportedValuesOf("timeZone") : FALLBACK_ZONES
  } catch {
    return FALLBACK_ZONES
  }
}

/** Whether the engine itself recognizes `zone` as an IANA time zone — used
 * instead of checking membership in the (possibly fallback/incomplete)
 * `zones` list, so a real zone the datalist happens not to enumerate is
 * still accepted. Rejects raw numeric UTC offsets (e.g. "+09:00") up front:
 * Chromium's Intl.DateTimeFormat accepts those as a `timeZone` value
 * without throwing, which would otherwise let one slip past this check even
 * though the Roadmap 3.4/3.5 contract requires an IANA zone name, not an
 * offset. */
function isValidTimeZone(zone: string): boolean {
  if (/^[+-]/.test(zone)) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

interface TimeZoneSelectorProps {
  value: string
  onChange: (zone: string) => void
}

/** Searchable IANA time zone picker (dashboard_ui_direction_en.md's Time-Zone
 * Request Contract) — a plain <input list=...> keeps this keyboard-accessible
 * without an extra dependency. Keeps its own draft text so the user can type
 * a partial zone name (filtering the datalist) without each keystroke being
 * reverted by the controlled `value` prop; only a recognized IANA zone is
 * ever committed via onChange. */
export function TimeZoneSelector({ value, onChange }: TimeZoneSelectorProps) {
  const zones = useMemo(() => listSupportedZones(), [])
  const [draft, setDraft] = useState(value)
  // Resync the draft when `value` changes externally (e.g. the parent reset
  // it) — done during render rather than in an effect, so it takes effect
  // in the same render instead of triggering an extra one.
  const [lastSyncedValue, setLastSyncedValue] = useState(value)
  if (value !== lastSyncedValue) {
    setLastSyncedValue(value)
    setDraft(value)
  }

  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}>
      Time zone
      <input
        className="soft-select"
        list="timezone-options"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          if (isValidTimeZone(e.target.value)) onChange(e.target.value)
        }}
        onBlur={(e) => {
          if (isValidTimeZone(e.target.value)) {
            onChange(e.target.value)
          } else {
            setDraft(value) // revert an unrecognized typed value back to the last committed zone
          }
        }}
        aria-label="Reporting time zone"
        style={{ width: 160 }}
      />
      <datalist id="timezone-options">
        {zones.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
    </label>
  )
}
