import { useCountdownLanguage } from "../hooks/useCountdownLanguage"
import { useUpcomingDisplayMode } from "../hooks/useUpcomingDisplayMode"

const LANGUAGE_LABELS = { zh: "中文", en: "English", ja: "日本語" } as const

/** Settings-area control for the Live Schedule Dock's one global "upcoming
 * time display" preference (spec: "Add one global user setting: upcoming
 * time display = absolute or countdown") plus the countdown label's own
 * language. Lives alongside the app's other cross-cutting settings
 * (Theme/TimeZone), not inside the Dock itself, so it reads as a real
 * preference rather than a one-off toggle buried in a popover. */
export function UpcomingDisplaySettings() {
  const [mode, setMode] = useUpcomingDisplayMode()
  const [language, setLanguage] = useCountdownLanguage()

  return (
    <>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}>
        Upcoming display
        <select
          className="soft-select"
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
          aria-label="Upcoming stream time display"
        >
          <option value="absolute">HH:mm</option>
          <option value="countdown">Countdown</option>
        </select>
      </label>

      {mode === "countdown" && (
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}>
          Countdown language
          <select
            className="soft-select"
            value={language}
            onChange={(e) => setLanguage(e.target.value as typeof language)}
            aria-label="Countdown label language"
          >
            {(Object.keys(LANGUAGE_LABELS) as (keyof typeof LANGUAGE_LABELS)[]).map((key) => (
              <option key={key} value={key}>
                {LANGUAGE_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  )
}
