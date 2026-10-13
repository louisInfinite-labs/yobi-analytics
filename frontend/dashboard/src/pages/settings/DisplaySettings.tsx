import { InstallSetting } from "../../features/pwa/components/InstallSetting"
import { LanguagePicker } from "../../shared/i18n/components/LanguagePicker"
import { UpcomingDisplaySettings } from "../../features/live-status/components/UpcomingDisplaySettings"
import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { useTimeFormat } from "../../shared/i18n/hooks/useTimeFormat"
import type { TimeFormat } from "../../shared/i18n/model/timeFormat"
import { t } from "../../shared/i18n/translations"

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
            <select
              className="oshi-videos__sort display-setting-select"
              aria-label={t(locale, "displaySettings.timeFormatLabel")}
              value={timeFormat}
              onChange={(event) => setTimeFormat(event.target.value as TimeFormat)}
            >
              {timeFormatOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="display-setting-row">
            <div className="display-setting-copy">
              <h2 className="display-setting-label">{t(locale, "displaySettings.upcomingLabel")}</h2>
              <p className="display-setting-help">{t(locale, "displaySettings.upcomingHelp")}</p>
            </div>
            <UpcomingDisplaySettings />
          </div>

          {/* Language Settings: the last Display Settings item (it used to be pinned to the Settings navbar's bottom). */}
          <div className="display-setting-row">
            <div className="display-setting-copy">
              <h2 className="display-setting-label">{t(locale, "displaySettings.languageLabel")}</h2>
              <p className="display-setting-help">{t(locale, "displaySettings.languageHelp")}</p>
            </div>
            <LanguagePicker />
          </div>

          <InstallSetting />
        </div>
      </div>
    </section>
  )
}
