import { useLocale } from "../hooks/useLocale"
import { t } from "../i18n/translations"

/** Placeholder for Sidebar's third nav destination (/setting) -- no
 * settings exist yet to configure here; this just gives the route
 * somewhere real to render instead of 404ing until an actual settings UI
 * is designed. */
export function SettingsPage() {
  const [locale] = useLocale()
  return (
    <div className="dashboard-page">
      <h1>{t(locale, "settingsPage.title")}</h1>
      <div className="state-panel">
        <p>{t(locale, "settingsPage.comingSoon")}</p>
      </div>
    </div>
  )
}
