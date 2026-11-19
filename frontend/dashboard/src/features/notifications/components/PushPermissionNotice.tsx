import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"
import { ensurePushEnabled, showPushDeniedHelp } from "../push/pushGate"
import { usePushHealth } from "../push/pushHealth"
import { usePushState } from "../push/pushState"

/** A persistent notice at the top of Notification Settings while the device's notification permission is denied, so the page never
 * suggests notifications are active when they cannot be delivered. It re-checks on focus/visibility (usePushState), so it disappears
 * by itself once the user allows notifications in the device settings and returns. Nothing here requests permission. */
export function PushPermissionNotice() {
  const [locale] = useLocale()
  const { supported, permission } = usePushState()
  const { health, recheck } = usePushHealth()
  if (supported && permission === "granted" && (health === "inactive" || health === "not-registered" || health === "endpoint-mismatch")) {
    // Permission is on, yet the backend cannot reach this device: say so instead of leaving the settings looking active. Reconnect is the explicit user
    // action that re-registers it (no permission prompt: it is already granted) and reads the registration back before this notice goes away.
    return (
      <div className="push-permission-notice" role="status">
        <div className="push-permission-notice__copy">
          <p className="push-permission-notice__title">{t(locale, "push.repairTitle")}</p>
          <p className="push-permission-notice__description">{t(locale, "push.repairDescription")}</p>
        </div>
        <button type="button" className="push-permission-notice__action" onClick={() => void ensurePushEnabled().then(recheck)}>
          {t(locale, "push.repairAction")}
        </button>
      </div>
    )
  }
  if (!supported || permission !== "denied") return null

  return (
    <div className="push-permission-notice" role="status">
      <div className="push-permission-notice__copy">
        <p className="push-permission-notice__title">{t(locale, "push.deniedTitle")}</p>
        <p className="push-permission-notice__description">{t(locale, "push.deniedDescription")}</p>
      </div>
      <button type="button" className="push-permission-notice__action" onClick={showPushDeniedHelp}>
        {t(locale, "push.deniedAction")}
      </button>
    </div>
  )
}
