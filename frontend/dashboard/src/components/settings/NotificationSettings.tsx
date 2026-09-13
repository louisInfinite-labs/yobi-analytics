import { useLocale } from "../../hooks/useLocale"
import { t } from "../../i18n/translations"

/** Notification Settings -- no notification settings exist yet to
 * configure here; this just gives SettingsSecondaryNavbar's second
 * section somewhere real to render instead of an empty panel until an
 * actual settings UI is designed. */
export function NotificationSettings() {
  const [locale] = useLocale()
  return (
    <div className="state-panel">
      <p>{t(locale, "notificationSettings.comingSoon")}</p>
    </div>
  )
}
