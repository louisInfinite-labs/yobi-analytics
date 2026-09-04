import { useEffect, useState } from "react"
import { apiRequest } from "../lib/apiClient"
import { getOrCreateClientId } from "../lib/clientId"
import { getPushSubscriptionStatus, subscribeToPush, unsubscribeFromPush } from "../lib/pushNotifications"
import { VAPID_PUBLIC_KEY } from "../lib/vapidPublicKey"

type Status = "checking" | "unsupported" | "subscribed" | "unsubscribed"

// Roadmap 4.6's own worked example uses these as the default local delivery
// windows during Japanese development; a real per-window settings UI is
// future work — this toggle only ever sets the on/off half of a preference.
const DEFAULT_DELIVERY_WINDOWS = ["08:00", "18:00"]

/** Persist this browser's own push subscription under its own clientId
 * (Roadmap 4.6, self-service — no admin key required). Best-effort: a
 * failure here never blocks the toggle's own local (browser-side)
 * subscribe/unsubscribe from working. */
function syncSubscriptionToBackend(clientId: string, subscription: PushSubscriptionJSON | null): void {
  const path = `/clients/${encodeURIComponent(clientId)}/push-subscription`
  const request = subscription ? apiRequest(path, { method: "PUT", body: subscription }) : apiRequest(path, { method: "DELETE" })
  request.catch(() => {
    // Best-effort — see docstring above.
  })
}

/** Persist this browser's own on/off notification preference under its own
 * clientId (Roadmap 4.6, self-service — no admin key required).
 * Best-effort, same reasoning as syncSubscriptionToBackend. */
function syncNotificationEnabledToBackend(clientId: string, enabled: boolean): void {
  apiRequest(`/clients/${encodeURIComponent(clientId)}/notification-preference`, {
    method: "PUT",
    body: {
      enabled,
      notificationLevel: "all",
      notificationTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      deliveryWindows: DEFAULT_DELIVERY_WINDOWS,
    },
  }).catch(() => {
    // Best-effort — see docstring above.
  })
}

/**
 * Toggle to enable/disable OS-level Web Push notifications for this browser
 * (Roadmap 4.6's chosen delivery mechanism — a Windows toast, not an
 * in-page list). Subscribing registers this browser with the push service
 * and persists both the subscription and an on/off notification preference
 * to the backend under this browser's own Roadmap 4.3 clientId, so the
 * Roadmap 4.6 scheduled dispatcher has something to actually deliver to.
 */
export function NotificationToggle() {
  const [status, setStatus] = useState<Status>("checking")

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
      <span className="notification-toggle__unsupported" title="This browser doesn't support push notifications">
        Notifications unavailable
      </span>
    )
  }

  const handleClick = async () => {
    const clientId = getOrCreateClientId()
    if (status === "subscribed") {
      await unsubscribeFromPush()
      setStatus("unsubscribed")
      syncSubscriptionToBackend(clientId, null)
      syncNotificationEnabledToBackend(clientId, false)
      return
    }
    const subscription = await subscribeToPush(VAPID_PUBLIC_KEY)
    setStatus(subscription ? "subscribed" : "unsubscribed")
    if (subscription) {
      syncSubscriptionToBackend(clientId, subscription)
      syncNotificationEnabledToBackend(clientId, true)
    }
  }

  return (
    <button
      type="button"
      className="soft-button"
      onClick={handleClick}
      disabled={status === "checking"}
      aria-pressed={status === "subscribed"}
    >
      {status === "subscribed" ? "🔔 Notifications on" : "🔕 Enable notifications"}
    </button>
  )
}
