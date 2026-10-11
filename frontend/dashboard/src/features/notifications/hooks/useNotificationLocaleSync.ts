import { useEffect } from "react"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { getSyncedNotificationLocale } from "../api/notificationPreferenceApi"
import { resyncNotificationPreferenceSilently } from "./useTopicNotificationPreferences"

/** Mounted once at the app root: keeps the language of this browser's push notifications equal to the dashboard language. When the
 * locale the backend last confirmed differs from the current one (the user changed the dashboard language, or this browser predates the
 * field) the full preference is re-sent -- only when notifications are enabled here; otherwise the enable flow sends the locale with the
 * master switch. A failed write leaves the marker unconfirmed, so the next start or language change retries. */
export function useNotificationLocaleSync(): void {
  const [locale] = useLocale()
  useEffect(() => {
    if (getSyncedNotificationLocale() === locale) return
    void resyncNotificationPreferenceSilently()
  }, [locale])
}
