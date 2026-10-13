import { registerServiceWorker } from "../../pwa/registerServiceWorker"

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

/** The browser/OS notification permission, kept apart from OshiYobi's own notification preference and from whether a
 * PushSubscription exists (three separate facts -- see pushGate.ts). "unsupported" when this browser has no Notification API. */
export type NotificationPermissionState = NotificationPermission | "unsupported"

export function getNotificationPermission(): NotificationPermissionState {
  if (typeof Notification === "undefined") return "unsupported"
  return Notification.permission
}

/** Resolve once this registration has an ACTIVATED service worker; reject if its worker is discarded.
 *
 * `register()` resolves as soon as the registration exists, while the worker is still "installing" on
 * a pristine profile -- and `pushManager.subscribe()` on a registration with no active worker throws
 * "AbortError: no active Service Worker". This waits on the worker's own state instead of a timer.
 * A worker that goes "redundant" (install failure, or it was replaced before activating) rejects, so a
 * broken service worker surfaces as an error instead of hanging the caller forever (unlike
 * `navigator.serviceWorker.ready`, which never rejects). With no worker to watch at all, falls back to
 * the platform's own `navigator.serviceWorker.ready`. */
async function waitForActiveWorker(registration: ServiceWorkerRegistration): Promise<void> {
  const worker = registration.active ?? registration.waiting ?? registration.installing
  if (!worker) {
    await navigator.serviceWorker.ready
    return
  }
  if (worker.state === "activated") return
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      if (worker.state === "activated") {
        worker.removeEventListener("statechange", check)
        resolve()
      } else if (worker.state === "redundant") {
        worker.removeEventListener("statechange", check)
        reject(new Error("Service worker became redundant before it activated"))
      }
    }
    worker.addEventListener("statechange", check)
    check()
  })
}

/** Request permission (only when it is still undecided), then create -- or reuse -- this browser's Web Push subscription.
 *
 * Returns the subscription (to send to the backend -- PUT /clients/{clientId}/push-subscription) or `null` if the browser doesn't
 * support push or permission is not granted. Never throws for either case -- both are expected outcomes, not errors; a caller should
 * treat `null` as "notifications unavailable", not a failure to report. This must only be called as the result of an explicit user
 * action (the permission prompt appears here): the explanation UI in pushGate.ts is what asks the user first.
 *
 * An already-DENIED permission is never re-requested: browsers do not reliably re-open the prompt, so the caller shows the
 * "turn it on in device settings" help instead. An already-granted one skips the prompt and goes straight to the subscription.
 *
 * Reuses the app's one service-worker registration (registerServiceWorker, also started at app start-up) and waits for its worker
 * to be ACTIVE before subscribing (a first-ever visit may still be installing it); throws if it never activates -- callers must
 * treat a throw as "could not enable", unlike the permission outcomes above which stay non-throwing.
 *
 * Reuses an already-existing subscription rather than creating a second one, since re-subscribing with the same
 * `applicationServerKey` from the same origin is a no-op the browser would otherwise just hand back anyway -- checking first makes
 * that explicit, and a MISSING subscription under a granted permission is simply created again.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscriptionJSON | null> {
  if (!isPushSupported()) return null

  const current = Notification.permission
  const permission = current === "granted" || current === "denied" ? current : await Notification.requestPermission()
  if (permission !== "granted") return null

  const registration = await registerServiceWorker()
  await waitForActiveWorker(registration)
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
