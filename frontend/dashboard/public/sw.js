// Web Push service worker (Roadmap 4.6 delivery mechanism).
//
// Must live at the site origin root (served here via Vite's public/) so
// its default scope covers the whole Dashboard, not just one sub-path.
// Registered from src/lib/pushNotifications.ts. Plain JS, not TypeScript:
// service workers run outside the app's module graph/build step, so this
// file is served and executed as-is, unbuilt.

self.addEventListener("push", (event) => {
  if (!event.data) return

  let payload
  try {
    payload = event.data.json()
  } catch {
    // A malformed/non-JSON push payload must not crash the service worker
    // (which would silently drop the notification with no visible cause)
    // — fall back to a generic notification instead.
    payload = { title: "Yobi Analytics", body: event.data.text() }
  }

  const title = payload.title || "Yobi Analytics"
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body,
      data: payload.data,
      icon: "/favicon.ico",
    }),
  )
})

// Clicking the OS notification focuses an already-open Dashboard tab
// rather than always opening a new one, so repeated notifications don't
// pile up duplicate tabs.
self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus()
      }
      if (self.clients.openWindow) return self.clients.openWindow("/")
      return undefined
    }),
  )
})
