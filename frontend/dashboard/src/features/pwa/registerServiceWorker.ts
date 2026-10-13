/** OshiYobi's one service worker (public/sw.js): Web Push delivery AND the PWA install requirement. */
export const SERVICE_WORKER_URL = "/sw.js"

/** At most one update check per hour while the app is brought back to the foreground (a Home Screen app can stay open for days). */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

let registered: { container: ServiceWorkerContainer; promise: Promise<ServiceWorkerRegistration> } | null = null

/** Registers /sw.js and returns its registration -- the single place anything in the app asks for it.
 *
 * Called once at start-up (main.tsx), so installability never depends on notification permission, and again by the push
 * subscription flow, which then REUSES this same registration instead of registering a second time. Calls share one
 * registration per ServiceWorkerContainer; a failed registration is not remembered, so the next caller retries. Rejects when
 * the browser has no service worker support or registration fails -- callers that only want the PWA side effect swallow it. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return Promise.reject(new Error("Service workers are not supported"))
  }
  const container = navigator.serviceWorker
  if (registered?.container === container) return registered.promise

  const promise = container.register(SERVICE_WORKER_URL, { scope: "/", updateViaCache: "none" })
  const entry = { container, promise }
  registered = entry
  promise.catch(() => {
    if (registered === entry) registered = null
  })
  return promise
}

/** Start-up registration, run once from main.tsx after the first paint work is queued. Never throws: an unsupported browser or a
 * failed registration just leaves the app without PWA/push capability, exactly as before. */
export function startServiceWorker(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return
  const start = () => {
    registerServiceWorker().then(watchForUpdates, () => undefined)
  }
  if (document.readyState === "complete") start()
  else window.addEventListener("load", start, { once: true })
}

/** Checks for a newer sw.js whenever the app returns to the foreground (throttled). The new worker activates by itself (sw.js
 * skips waiting) and holds no caches, so there is nothing to reload and no old-JS/new-HTML mix to guard against. */
function watchForUpdates(registration: ServiceWorkerRegistration): void {
  let lastCheck = Date.now()
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return
    lastCheck = Date.now()
    registration.update().catch(() => undefined)
  })
}
