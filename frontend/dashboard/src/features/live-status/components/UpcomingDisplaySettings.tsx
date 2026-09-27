import { Select } from "antd"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"
import { useUpcomingDisplayMode } from "../hooks/useUpcomingDisplayMode"

/** Control for the Live Schedule Dock's one global "upcoming time display"
 * preference (absolute or countdown). Rendered inside a Display Settings
 * row, which supplies the label and helper text. */
export function UpcomingDisplaySettings() {
  const [mode, setMode] = useUpcomingDisplayMode()
  const [locale] = useLocale()

  return (
    <Select
      className="display-setting-select"
      classNames={{ popup: { root: "display-settings-select-dropdown" } }}
      value={mode}
      onChange={(next) => setMode(next as typeof mode)}
      aria-label={t(locale, "displaySettings.upcomingLabel")}
      options={[
        { value: "absolute", label: "HH:mm" },
        { value: "countdown", label: t(locale, "displaySettings.upcomingCountdownOption") },
      ]}
    />
  )
}
