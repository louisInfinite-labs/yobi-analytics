import { useEffect, useState } from "react"
import { apiRequest } from "../lib/apiClient"
import { getOrCreateClientSecret } from "../lib/clientCredential"
import { getOrCreateClientId } from "../lib/clientId"
import { getPushSubscriptionStatus, subscribeToPush, unsubscribeFromPush } from "../lib/pushNotifications"
import { VAPID_PUBLIC_KEY } from "../lib/vapidPublicKey"

type Status = "checking" | "unsupported" | "subscribed" | "unsubscribed"

// Roadmap 4.6's own worked example uses these as the default local delivery
// windows during Japanese development; a real per-window settings UI is
// future work — this toggle only ever sets the on/off half of a preference.
const DEFAULT_DELIVERY_WINDOWS = ["08:00", "18:00"]

/** Persist this browser's own push subscription under its own clientId
 * (Roadmap 4.6, self-service). `clientSecret` (PR #18 CodeRabbit
 * hardening, from clientCredential.ts) proves this call actually owns
 * `clientId` — api_handler.py's route rejects it without a matching
 * X-Client-Secret header. Returns the in-flight request so the caller
 * (handleClick) can await and coordinate it with
 * syncNotificationEnabledToBackend rather than firing both and hoping —
 * see handleClick's own comment for why that coordination matters. */
function syncSubscriptionToBackend(
  clientId: string,
  clientSecret: string | null,
  subscription: PushSubscriptionJSON | null,
): Promise<unknown> {
  const path = `/clients/${encodeURIComponent(clientId)}/push-subscription`
  const headers = clientSecret ? { "X-Client-Secret": clientSecret } : undefined
  return subscription
    ? apiRequest(path, { method: "PUT", body: subscription, headers })
    : apiRequest(path, { method: "DELETE", headers })
}

/** Persist this browser's own on/off notification preference under its own
 * clientId (Roadmap 4.6, self-service). See syncSubscriptionToBackend's
 * docstring — same clientSecret/coordination reasoning. */
function syncNotificationEnabledToBackend(clientId: string, clientSecret: string | null, enabled: boolean): Promise<unknown> {
  return apiRequest(`/clients/${encodeURIComponent(clientId)}/notification-preference`, {
    method: "PUT",
    headers: clientSecret ? { "X-Client-Secret": clientSecret } : undefined,
    body: {
      enabled,
      notificationLevel: "all",
      notificationTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      deliveryWindows: DEFAULT_DELIVERY_WINDOWS,
    },
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
  const [syncError, setSyncError] = useState(false)
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
      <span className="notification-toggle__unsupported" title="This browser doesn't support push notifications">
        Notifications unavailable
      </span>
    )
  }

  const handleClick = async () => {
    if (isSyncing) return
    setIsSyncing(true)
    setSyncError(false)
    try {
      const clientId = getOrCreateClientId()

      if (status === "subscribed") {
        // Unsubscribe locally first (the user explicitly asked to turn
        // off), then try to tell the backend. If that sync fails, the
        // visible status still reflects the browser's real (now
        // unsubscribed) state rather than claiming "on" — the
        // alternative, leaving status "subscribed" on a sync failure, is
        // what let the dispatcher retain an enabled preference the UI had
        // already claimed was off.
        await unsubscribeFromPush()
        setStatus("unsubscribed")
        try {
          // A null secret (registration failed — network, or storage) is
          // still passed through: the sync calls below will 403 and land
          // in this same catch, rather than needing a separate branch.
          //
          // The subscription DELETE and preference PUT below are two
          // separate backend writes, not one atomic transaction — if one
          // succeeds and the other fails, the stored pair is briefly
          // inconsistent. This is safe rather than merely tidy:
          // notification_dispatcher.py only ever delivers to a client
          // that has *both* a stored subscription *and* a stored
          // preference (it skips one with no subscription record, and
          // only iterates clients that have a preference record at all)
          // — so a partial write here can leave stale data, but can never
          // cause the dispatcher to send this client an unwanted push.
          const clientSecret = await getOrCreateClientSecret(clientId)
          await syncSubscriptionToBackend(clientId, clientSecret, null)
          await syncNotificationEnabledToBackend(clientId, clientSecret, false)
        } catch {
          setSyncError(true)
        }
        return
      }

      const subscription = await subscribeToPush(VAPID_PUBLIC_KEY)
      if (!subscription) {
        setStatus("unsubscribed")
        return
      }
      try {
        // Same partial-write safety note as the disable path above.
        const clientSecret = await getOrCreateClientSecret(clientId)
        await syncSubscriptionToBackend(clientId, clientSecret, subscription)
        await syncNotificationEnabledToBackend(clientId, clientSecret, true)
        setStatus("subscribed")
      } catch {
        // Neither backend write is confirmed, so the dispatcher has no
        // reliable (subscription, enabled preference) pair for this
        // client — undo the local browser subscription too rather than
        // showing "on" for a subscription the backend doesn't actually
        // know about.
        await unsubscribeFromPush()
        setStatus("unsubscribed")
        setSyncError(true)
      }
    } finally {
      setIsSyncing(false)
    }
  }

  return (
    <span className="notification-toggle">
      <button
        type="button"
        className="soft-button"
        onClick={handleClick}
        disabled={status === "checking" || isSyncing}
        aria-pressed={status === "subscribed"}
      >
        {status === "subscribed" ? "🔔 Notifications on" : "🔕 Enable notifications"}
      </button>
      {syncError && (
        <span role="alert" className="notification-toggle__error">
          Couldn't sync with the server — try again.
        </span>
      )}
    </span>
  )
}
