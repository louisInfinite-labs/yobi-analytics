/** Convert a URL-safe base64 VAPID public key string into the Uint8Array
 * shape `PushManager.subscribe`'s `applicationServerKey` expects — the Web
 * Push spec's standard conversion; browsers accept only this binary form,
 * not the base64 string directly. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

/** Whether this browser supports the APIs needed to receive Web Push notifications. */
export function isPushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
}

/** Register the notification service worker, request permission, and subscribe to Web Push.
 *
 * Returns the subscription (to send to the backend — Roadmap 4.5's opaque
 * remote-config store, under a well-known key such as
 * `"webPushSubscription"` — once that endpoint is deployed), or `null` if
 * the browser doesn't support push or the user denied/dismissed the
 * permission prompt. Never throws for either case — both are expected
 * outcomes, not errors; a caller should treat `null` as "notifications
 * unavailable this session", not a failure to report.
 *
 * Reuses an already-existing subscription rather than creating a second
 * one, since re-subscribing with the same `applicationServerKey` from the
 * same origin is a no-op the browser would otherwise just hand back
 * anyway — checking first makes that explicit.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscriptionJSON | null> {
  if (!isPushSupported()) return null

  const permission = await Notification.requestPermission()
  if (permission !== "granted") return null

  const registration = await navigator.serviceWorker.register("/sw.js")
  const existing = await registration.pushManager.getSubscription()
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      // @types/node's ambient Uint8Array augmentation widens its buffer
      // type param to ArrayBufferLike (SharedArrayBuffer included), which
      // no longer structurally matches DOM's BufferSource — the array
      // itself is always backed by a plain ArrayBuffer here, so this cast
      // reflects a real TS-typing gap between the two ambient lib sets,
      // not a runtime risk.
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
    }))
  return subscription.toJSON()
}

/** This browser's current push subscription status, without prompting for
 * permission or creating a new subscription — for initializing a toggle
 * UI's displayed state on mount, before the user has clicked anything. */
export async function getPushSubscriptionStatus(): Promise<"unsupported" | "subscribed" | "unsubscribed"> {
  if (!isPushSupported()) return "unsupported"
  const registration = await navigator.serviceWorker.getRegistration("/sw.js")
  const subscription = await registration?.pushManager.getSubscription()
  return subscription ? "subscribed" : "unsubscribed"
}

/** Unsubscribe this browser from Web Push, if it currently has a subscription.
 *
 * Returns whether a subscription was actually removed — `false` both when
 * push isn't supported and when there was simply nothing to unsubscribe,
 * since neither is an error a caller needs to distinguish.
 */
export async function unsubscribeFromPush(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false
  const registration = await navigator.serviceWorker.getRegistration("/sw.js")
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return false
  return subscription.unsubscribe()
}
