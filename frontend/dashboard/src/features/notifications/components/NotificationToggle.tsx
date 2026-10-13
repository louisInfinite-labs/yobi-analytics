import { useEffect, useState } from "react"
import { Button } from "antd"
import { Bell, BellOff } from "lucide-react"
import { getPushSubscriptionStatus } from "../push/pushNotifications"
import { disablePushNotifications, enablePushNotifications } from "../push/pushEnrollment"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"

type Status = "checking" | "unsupported" | "subscribed" | "unsubscribed"

/** "failed": a backend write was rejected and the toggle kept (or restored) its previous state.
 * "uncertain": an enable attempt failed AND the cleanup that undoes any half-committed backend
 * write also failed, so the server may still have notifications enabled. */
type SyncError = "failed" | "uncertain"

/**
 * Toggle to enable/disable OS-level Web Push notifications for this browser
 * (Roadmap 4.6's chosen delivery mechanism — a Windows toast, not an
 * in-page list). Subscribing registers this browser with the push service
 * and persists both the subscription and an on/off notification preference
 * to the backend under this browser's own Roadmap 4.3 clientId, so the
 * Roadmap 4.6 scheduled dispatcher has something to actually deliver to.
 */
export function NotificationToggle() {
  const [locale] = useLocale()
  const [status, setStatus] = useState<Status>("checking")
  const [syncError, setSyncError] = useState<SyncError | null>(null)
  // Guards against a double-click (or a slow tap registering twice)
  // starting a second overlapping handleClick before the first one's
  // browser-permission-prompt/backend-sync round trip settles — without
  // it, `status` read at the top of a second call could still be the
  // pre-click value, letting two subscribe (or a subscribe racing a
  // disable) attempts interleave.
  const [isSyncing, setIsSyncing] = useState(false)

  useEffect(() => {
    let cancelled = false
    getPushSubscriptionStatus().then((result) => {
      if (!cancelled) setStatus(result)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (status === "unsupported") {
    return (
      <span className="notification-toggle__unsupported" title={t(locale, "notificationToggle.unsupportedTooltip")}>
        {t(locale, "notificationToggle.unavailable")}
      </span>
    )
  }

  const handleClick = async () => {
    if (isSyncing) return
    setIsSyncing(true)
    setSyncError(null)
    try {
      if (status === "subscribed") {
        // Backend first (see disablePushNotifications): on a failed preference write the toggle keeps its "on" state and shows the
        // error -- the UI never claims "off" while the backend still has notifications on.
        const outcome = await disablePushNotifications()
        if (outcome === "failed") {
          setSyncError("failed")
          return
        }
        setStatus("unsubscribed")
        if (outcome === "disabled-cleanup-failed") setSyncError("failed")
        return
      }

      const { outcome } = await enablePushNotifications()
      if (outcome === "enabled") {
        setStatus("subscribed")
        return
      }
      // Every other outcome leaves this browser unsubscribed ("not-granted": denied/dismissed, nothing written; "failed"/"uncertain":
      // the half-made subscription was undone). "uncertain" additionally says the server may still have notifications enabled.
      setStatus("unsubscribed")
      if (outcome === "failed") setSyncError("failed")
      else if (outcome === "uncertain") setSyncError("uncertain")
    } finally {
      setIsSyncing(false)
    }
  }

  return (
    <span className="notification-toggle">
      <Button
        onClick={handleClick}
        disabled={status === "checking" || isSyncing}
        aria-pressed={status === "subscribed"}
        icon={status === "subscribed" ? <Bell size={14} aria-hidden="true" /> : <BellOff size={14} aria-hidden="true" />}
      >
        {status === "subscribed" ? t(locale, "notificationToggle.on") : t(locale, "notificationToggle.enable")}
      </Button>
      {syncError && (
        <span role="alert" className="notification-toggle__error">
          {syncError === "uncertain"
            ? "Couldn't sync with the server — notifications may still be on there. Try again."
            : "Couldn't sync with the server — try again."}
        </span>
      )}
    </span>
  )
}
