import { Select } from "antd"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { useTimeFormat } from "../../../shared/i18n/hooks/useTimeFormat"
import { t } from "../../../shared/i18n/translations"
import { useUpcomingDisplayMode } from "../hooks/useUpcomingDisplayMode"

/** Control for the Live Schedule Dock's one global "upcoming time display"
 * preference (absolute or countdown). Rendered inside a Display Settings
 * row, which supplies the label and helper text. */
export function UpcomingDisplaySettings() {
  const [mode, setMode] = useUpcomingDisplayMode()
  const [locale] = useLocale()
  const [timeFormat] = useTimeFormat()

  // Absolute mode always renders through formatAbsoluteTime/formatClockTime,
  // so this label must track the global timeFormat rather than stay
  // hardcoded to "HH:mm" -- otherwise it misleadingly claims 24-hour clock
  // times while a 12h user is actually shown "h:mm AM/PM".
  const absoluteLabel = timeFormat === "12h" ? "h:mm AM/PM" : "HH:mm"

  return (
    <Select
      className="display-setting-select"
      classNames={{ popup: { root: "display-settings-select-dropdown" } }}
      value={mode}
      onChange={(next) => setMode(next as typeof mode)}
      aria-label={t(locale, "displaySettings.upcomingLabel")}
      options={[
        { value: "absolute", label: absoluteLabel },
        { value: "countdown", label: t(locale, "displaySettings.upcomingCountdownOption") },
      ]}
    />
  )
}
