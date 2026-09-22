import { Select } from "antd"
import { useCountdownLanguage } from "../../../shared/i18n/hooks/useCountdownLanguage"
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
      <label className="preference-control">
        Upcoming display
        <Select
          value={mode}
          onChange={(next) => setMode(next as typeof mode)}
          aria-label="Upcoming stream time display"
          options={[
            { value: "absolute", label: "HH:mm" },
            { value: "countdown", label: "Countdown" },
          ]}
          popupMatchSelectWidth={false}
          size="small"
        />
      </label>

      {mode === "countdown" && (
        <label className="preference-control">
          Countdown language
          <Select
            value={language}
            onChange={(next) => setLanguage(next as typeof language)}
            aria-label="Countdown label language"
            options={(Object.keys(LANGUAGE_LABELS) as (keyof typeof LANGUAGE_LABELS)[]).map((key) => ({
              value: key,
              label: LANGUAGE_LABELS[key],
            }))}
            popupMatchSelectWidth={false}
            size="small"
          />
        </label>
      )}
    </>
  )
}
