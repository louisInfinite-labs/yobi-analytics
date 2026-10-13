import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"
import { showPushDeniedHelp } from "../push/pushGate"
import { usePushState } from "../push/pushState"

/** A persistent notice at the top of Notification Settings while the device's notification permission is denied, so the page never
 * suggests notifications are active when they cannot be delivered. It re-checks on focus/visibility (usePushState), so it disappears
 * by itself once the user allows notifications in the device settings and returns. Nothing here requests permission. */
export function PushPermissionNotice() {
  const [locale] = useLocale()
  const { supported, permission } = usePushState()
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
