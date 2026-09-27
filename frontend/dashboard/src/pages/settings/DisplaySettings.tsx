import { Select } from "antd"
import { UpcomingDisplaySettings } from "../../features/live-status/components/UpcomingDisplaySettings"
import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { useTimeFormat } from "../../shared/i18n/hooks/useTimeFormat"
import type { TimeFormat } from "../../shared/i18n/model/timeFormat"
import { t } from "../../shared/i18n/translations"

const SELECT_CLASS_NAMES = { popup: { root: "display-settings-select-dropdown" } }

export function DisplaySettings() {
  const [locale] = useLocale()
  const [timeFormat, setTimeFormat] = useTimeFormat()

  const timeFormatOptions: { value: TimeFormat; label: string }[] = [
    { value: "24h", label: t(locale, "displaySettings.timeFormat24h") },
    { value: "12h", label: t(locale, "displaySettings.timeFormat12h") },
  ]

  return (
    <section className="display-settings-page" aria-labelledby="display-settings-title">
      <div className="display-settings-content">
        <header className="settings-page-header">
          <h1 id="display-settings-title" className="settings-page-title">
            {t(locale, "displaySettings.title")}
          </h1>
          <p className="settings-page-description">{t(locale, "displaySettings.description")}</p>
        </header>
        <div className="display-settings-header-divider" />

        <div className="display-settings-list">
          <div className="display-setting-row">
            <div className="display-setting-copy">
              <h2 className="display-setting-label">{t(locale, "displaySettings.timeFormatLabel")}</h2>
              <p className="display-setting-help">{t(locale, "displaySettings.timeFormatHelp")}</p>
            </div>
            <Select
              className="display-setting-select"
              classNames={SELECT_CLASS_NAMES}
              aria-label={t(locale, "displaySettings.timeFormatLabel")}
              options={timeFormatOptions}
              value={timeFormat}
              onChange={setTimeFormat}
            />
          </div>

          <div className="display-setting-row">
            <div className="display-setting-copy">
              <h2 className="display-setting-label">{t(locale, "displaySettings.upcomingLabel")}</h2>
              <p className="display-setting-help">{t(locale, "displaySettings.upcomingHelp")}</p>
            </div>
            <UpcomingDisplaySettings />
          </div>
        </div>
      </div>
    </section>
  )
}
