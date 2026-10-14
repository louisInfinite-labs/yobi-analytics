import { useEffect } from "react"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { getBrowserTimeZone, getSyncedNotificationLocale, getSyncedNotificationTimeZone } from "../api/notificationPreferenceApi"
import { resyncNotificationPreferenceSilently } from "./useTopicNotificationPreferences"

/** Mounted once at the app root: keeps what the backend knows about this browser equal to what the browser reports now -- the dashboard
 * language (the language of its push notifications) and its IANA time zone (the zone its LOCAL new-video delivery times are in). When
 * either differs from what the backend last confirmed (the user changed the language, moved to another time zone, or this browser
 * predates the field) the full preference is re-sent -- only when notifications are enabled here; otherwise the enable flow sends them with
 * the master switch. The time zone is re-checked whenever the app becomes visible again, so a PWA that stayed open while the device
 * crossed zones is corrected on its next use. A failed write leaves the marker unconfirmed, so the next start, visibility change or
 * language change retries. */
export function useNotificationLocaleSync(): void {
  const [locale] = useLocale()
  useEffect(() => {
    if (getSyncedNotificationLocale() === locale && getSyncedNotificationTimeZone() === getBrowserTimeZone()) return
    void resyncNotificationPreferenceSilently()
  }, [locale])

  useEffect(() => {
    const resyncWhenTheTimeZoneChanged = () => {
      if (document.visibilityState === "hidden") return
      const synced = getSyncedNotificationTimeZone()
      // Never confirmed (null) is the first-run case already handled above (and by the enable flow); only a KNOWN zone that changed counts.
      if (synced !== null && synced !== getBrowserTimeZone()) void resyncNotificationPreferenceSilently()
    }
    document.addEventListener("visibilitychange", resyncWhenTheTimeZoneChanged)
    window.addEventListener("focus", resyncWhenTheTimeZoneChanged)
    return () => {
      document.removeEventListener("visibilitychange", resyncWhenTheTimeZoneChanged)
      window.removeEventListener("focus", resyncWhenTheTimeZoneChanged)
    }
  }, [])
}
