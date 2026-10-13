import { useEffect, useSyncExternalStore } from "react"
import { getNotificationPermission, getPushSubscriptionStatus, isPushSupported, type NotificationPermissionState } from "./pushNotifications"

/** Three separate facts about notifications on this device -- never collapsed into one boolean:
 *  - `permission`: the browser/OS Notification.permission;
 *  - `subscribed`: whether a PushSubscription exists on the service-worker registration;
 *  - (OshiYobi's own saved notification preference is a third fact and lives in the backend preference, not here.) */
export interface PushState {
  supported: boolean
  permission: NotificationPermissionState
  subscribed: boolean
}

// Nothing is read at import time: the first real state arrives with the first refreshPushState() (every consumer triggers one on mount).
let snapshot: PushState = { supported: false, permission: "unsupported", subscribed: false }
const listeners = new Set<() => void>()

function sameState(a: PushState, b: PushState): boolean {
  return a.supported === b.supported && a.permission === b.permission && a.subscribed === b.subscribed
}

/** Re-reads permission and subscription from the browser (the device may have changed either while the app was in the background)
 * and publishes the result to every mounted consumer. Resolves to the fresh state; an unreadable subscription counts as "none". */
export async function refreshPushState(): Promise<PushState> {
  let subscribed = false
  try {
    subscribed = (await getPushSubscriptionStatus()) === "subscribed"
  } catch {
    subscribed = false
  }
  const next: PushState = { supported: isPushSupported(), permission: getNotificationPermission(), subscribed }
  if (!sameState(next, snapshot)) {
    snapshot = next
    listeners.forEach((listener) => listener())
  }
  return snapshot
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The current push state, re-checked on mount and every time the user comes back to the app (window focus / the tab becoming
 * visible again) -- so changing the permission in the device or browser settings and returning needs no manual reload. */
export function usePushState(): PushState {
  const state = useSyncExternalStore(subscribe, () => snapshot)
  useEffect(() => {
    void refreshPushState()
    const recheck = () => {
      if (document.visibilityState === "hidden") return
      void refreshPushState()
    }
    window.addEventListener("focus", recheck)
    document.addEventListener("visibilitychange", recheck)
    return () => {
      window.removeEventListener("focus", recheck)
      document.removeEventListener("visibilitychange", recheck)
    }
  }, [])
  return state
}

/** Test seam: back to the nothing-read-yet state. */
export function resetPushStateForTests(): void {
  snapshot = { supported: false, permission: "unsupported", subscribed: false }
  listeners.clear()
}
