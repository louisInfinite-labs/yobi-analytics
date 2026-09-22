import { UpcomingDisplaySettings } from "../../features/live-status/components/UpcomingDisplaySettings"
import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { t } from "../../shared/i18n/translations"
import { ThemeSelector } from "../../shared/theme/ThemeSelector"

export function DisplaySettings() {
  const [locale] = useLocale()
  return (
    <section className="display-settings" aria-labelledby="display-settings-title">
      <div className="settings-section-heading">
        <div>
          <h1 id="display-settings-title">{t(locale, "displaySettings.title")}</h1>
          <p>{t(locale, "displaySettings.description")}</p>
        </div>
      </div>

      <div className="display-settings__group">
        <h2>{t(locale, "displaySettings.appearanceGroup")}</h2>
        <ThemeSelector />
      </div>

      <div className="display-settings__group">
        <h2>{t(locale, "displaySettings.upcomingStreamsGroup")}</h2>
        <UpcomingDisplaySettings />
      </div>
    </section>
  )
}
