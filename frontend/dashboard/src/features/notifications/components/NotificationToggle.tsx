import { useEffect, useState } from "react"
import { Button } from "antd"
import { Bell, BellOff } from "lucide-react"
import { apiRequest } from "../../../shared/api/apiClient"
import { getOrCreateClientSecret } from "../../../shared/api/clientCredential"
import { getOrCreateClientId } from "../../../shared/api/clientId"
import { getPushSubscriptionStatus, subscribeToPush, unsubscribeFromPush } from "../push/pushNotifications"
import { VAPID_PUBLIC_KEY } from "../push/vapidPublicKey"

type Status = "checking" | "unsupported" | "subscribed" | "unsubscribed"

// Roadmap 4.6's own worked example uses these as the default local delivery
// windows during Japanese development; a real per-window settings UI is
// future work — this toggle only ever sets the on/off half of a preference.
const DEFAULT_DELIVERY_WINDOWS = ["08:00", "18:00"]

/** "failed": a backend write was rejected and the toggle kept (or restored) its previous state.
 * "uncertain": an enable attempt failed AND the cleanup that undoes any half-committed backend
 * write also failed, so the server may still have notifications enabled. */
type SyncError = "failed" | "uncertain"

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
      <span className="notification-toggle__unsupported" title="This browser doesn't support push notifications">
        Notifications unavailable
      </span>
    )
  }

  const handleClick = async () => {
    if (isSyncing) return
    setIsSyncing(true)
    setSyncError(null)
    try {
      const clientId = getOrCreateClientId()

      if (status === "subscribed") {
        // Backend first. The preference write (`enabled: false`) is what
        // actually stops notification_dispatcher.py, so it must succeed
        // before anything local changes: if it fails, the browser
        // subscription and the "on" status stay exactly as they were and
        // the error is shown -- the UI never claims "off" while the backend
        // still has notifications on. A null secret (registration failed —
        // network, or storage) is still passed through: the call 403s and
        // lands in this same catch, rather than needing a separate branch.
        let clientSecret: string | null
        try {
          clientSecret = await getOrCreateClientSecret(clientId)
          await syncNotificationEnabledToBackend(clientId, clientSecret, false)
        } catch {
          setSyncError("failed")
          return
        }
        await unsubscribeFromPush()
        setStatus("unsubscribed")
        try {
          // Only cleanup remains. The preference is already disabled, and
          // notification_dispatcher.py only delivers to a client that has
          // both an enabled preference and a stored subscription -- so a
          // failure here leaves a stale subscription record that can never
          // cause an unwanted push; it is still reported so the user knows.
          await syncSubscriptionToBackend(clientId, clientSecret, null)
        } catch {
          setSyncError("failed")
        }
        return
      }

      const subscription = await subscribeToPush(VAPID_PUBLIC_KEY)
      if (!subscription) {
        setStatus("unsubscribed")
        return
      }
      // Declared outside the try so the catch below can still use it for
      // best-effort reconciliation (see catch's own comment) even when
      // the failure happened partway through, after a secret was obtained.
      let clientSecret: string | null = null
      try {
        // Same partial-write safety note as the disable path above.
        clientSecret = await getOrCreateClientSecret(clientId)
        await syncSubscriptionToBackend(clientId, clientSecret, subscription)
        await syncNotificationEnabledToBackend(clientId, clientSecret, true)
        setStatus("subscribed")
      } catch {
        // Neither backend write is confirmed from this call's own point of
        // view, so undo the local browser subscription rather than
        // showing "on" for a subscription the backend might not actually
        // have. But "not confirmed here" isn't the same as "didn't
        // happen": a write can commit server-side even though this call's
        // own promise rejected (e.g. its response was lost after the
        // server already processed it) — the AND-gate safety note above
        // only holds if a partial failure doesn't quietly leave *both*
        // pieces present. So clean up any such orphaned state with the same
        // secret -- each call on its own, so one failing never stops the
        // other. The dispatcher only delivers to a client that has BOTH an
        // enabled preference and a stored subscription, so the server can
        // only still push if BOTH cleanups failed; only then say so
        // ("uncertain") instead of swallowing it. The UI correctly shows
        // "off" for this browser either way.
        await unsubscribeFromPush()
        setStatus("unsubscribed")
        setSyncError("failed")
        if (clientSecret) {
          let preferenceCleaned = true
          let subscriptionCleaned = true
          try {
            await syncNotificationEnabledToBackend(clientId, clientSecret, false)
          } catch {
            preferenceCleaned = false
          }
          try {
            await syncSubscriptionToBackend(clientId, clientSecret, null)
          } catch {
            subscriptionCleaned = false
          }
          if (!preferenceCleaned && !subscriptionCleaned) setSyncError("uncertain")
        }
      }
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
        {status === "subscribed" ? "Notifications on" : "Enable notifications"}
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
