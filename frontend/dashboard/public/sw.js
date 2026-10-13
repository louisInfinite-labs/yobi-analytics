// OshiYobi's single service worker: Web Push delivery AND the PWA install requirement.
//
// Must live at the site origin root (served here via Vite's public/) so its default scope covers the whole app.
// Registered once at app start-up from src/features/pwa/registerServiceWorker.ts (never as a side effect of enabling
// notifications); the push subscription reuses that same registration. Plain JS, not TypeScript: service workers run
// outside the app's module graph/build step, so this file is served and executed as-is, unbuilt.
//
// Deliberately NO fetch handler and NO caches: OshiYobi is a live-data product (Live Status, Schedule, Home live data,
// notification state), so nothing here may ever answer a request from a stale copy. Because nothing is cached, a new
// worker can take over immediately without leaving old JS paired with new HTML -- hence skipWaiting/claim below.

self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

const NOTIFICATION_ICON = "/icons/icon-192.png"

self.addEventListener("push", (event) => {
  if (!event.data) return

  let payload
  try {
    payload = event.data.json()
  } catch {
    // A malformed/non-JSON push payload must not crash the service worker
    // (which would silently drop the notification with no visible cause)
    // — fall back to a generic notification instead.
    payload = { title: "OshiYobi", body: event.data.text() }
  }

  const title = payload.title || "OshiYobi"
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body,
      data: payload.data,
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_ICON,
    }),
  )
})

// The in-app route a notification asks to open: an optional same-origin path in the payload's data (`url` or `path`).
// Today's payloads carry only { videoId }, so this is null and a tap simply opens/focuses the app; it is read defensively
// so a route-carrying payload (e.g. "/creator/aizawa-ema") works without another service-worker change. Anything that is
// not a same-origin http(s) URL is ignored -- a push payload must never be able to send the user to another site.
function payloadRoute(data) {
  const raw = data && (data.url || data.path)
  if (typeof raw !== "string" || raw === "") return null
  try {
    const target = new URL(raw, self.location.origin)
    if (target.origin !== self.location.origin) return null
    return target.pathname + target.search + target.hash
  } catch {
    return null
  }
}

// Tapping a notification focuses an already-open OshiYobi window rather than always opening a new one, so repeated
// notifications don't pile up duplicate windows. With a payload route, the window is moved there (the SPA's own
// route handling takes over); without one, the window is only focused and keeps whatever page it was on.
self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const route = payloadRoute(event.notification.data)
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clientList) => {
      const windows = clientList.filter((client) => "focus" in client)
      const onRoute = route ? windows.find((client) => new URL(client.url).pathname + new URL(client.url).search === route) : null
      const target = onRoute ?? windows[0]
      if (target) {
        if (route && !onRoute && "navigate" in target) {
          try {
            const navigated = await target.navigate(route)
            return (navigated ?? target).focus()
          } catch {
            // Navigation can be refused (e.g. an uncontrolled client): focus it where it is.
          }
        }
        return target.focus()
      }
      if (self.clients.openWindow) return self.clients.openWindow(route ?? "/")
      return undefined
    }),
  )
})
