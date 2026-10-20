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
    showWithOptionalImage(
      title,
      {
        body: payload.body,
        data: payload.data,
        icon: NOTIFICATION_ICON,
        badge: NOTIFICATION_ICON,
      },
      notificationImage(payload.data),
    ),
  )
})

// The only image hosts/paths a notification may show: a YouTube video thumbnail (https://i.ytimg.com/vi/<11-char id>/<size>.jpg, or the same
// path on img.youtube.com), exactly the form the dispatcher derives from a videoId (src/notifications/notification_payload.py). Anything else
// -- another host, http, a port, credentials, a query/hash, another path -- is dropped, so a push payload can never make the browser fetch an
// arbitrary external image.
const IMAGE_HOSTS = new Set(["i.ytimg.com", "img.youtube.com"])
const IMAGE_PATH = /^\/vi\/[A-Za-z0-9_-]{11}\/(?:default|mqdefault|hqdefault|sddefault|maxresdefault)\.jpg$/

// The validated thumbnail URL from the payload's data (`image`), or null. Platforms without rich notification images (e.g. iOS web push, some
// desktop browsers) simply ignore the option, so a valid image is always safe to pass.
function notificationImage(data) {
  const raw = data && data.image
  if (typeof raw !== "string" || raw === "") return null
  try {
    const target = new URL(raw)
    if (target.protocol !== "https:" || !IMAGE_HOSTS.has(target.hostname) || target.port !== "") return null
    if (target.username || target.password || target.search || target.hash || !IMAGE_PATH.test(target.pathname)) return null
    return target.origin + target.pathname
  } catch {
    return null
  }
}

// Shows the notification with its thumbnail when there is a valid one. A thumbnail that cannot be loaded is the browser's concern (it shows the
// notification without the picture); and if showing WITH the image is itself refused, the notification is shown again without it -- an image can
// never be the reason a notification does not appear.
async function showWithOptionalImage(title, options, image) {
  if (image) {
    try {
      return await self.registration.showNotification(title, { ...options, image })
    } catch {
      // Fall through to the plain notification below.
    }
  }
  return self.registration.showNotification(title, options)
}

// The in-app route a notification asks to open: an optional same-origin path in the payload's data (`url` or `path`).
// Creator-level notifications (live start / advance / catch-up reminders and new videos) carry the creator's Home route,
// e.g. "/creator/aizawa-ema" (built by the dispatcher, src/notifications/creator_route.py); a payload without one gives
// null and a tap simply opens/focuses the app. Anything that is not a same-origin http(s) URL is ignored -- a push
// payload must never be able to send the user to another site.
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

// A video-specific notification (new upload, live start/advance/catch-up reminder) carries the exact YouTube video id in `data.videoId`. When the
// payload's route is a creator Home (`/creator/<slug>`, nothing else) and the id is a well-formed 11-character YouTube id, the route asks the app
// for that exact video: `/creator/<slug>?video=<id>`. The app (src/features/video-deep-link) validates it again, checks the video's current
// availability and either plays it or explains why it cannot. Any other id (malformed, or a payload without a creator route) leaves the plain route,
// so a payload can never put anything but a bare video id into the URL.
const CREATOR_ROUTE = /^\/creator\/[a-z0-9]+(?:-[a-z0-9]+)*$/
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

function notificationRoute(data) {
  const route = payloadRoute(data)
  const videoId = data && data.videoId
  if (route && CREATOR_ROUTE.test(route) && typeof videoId === "string" && YOUTUBE_VIDEO_ID.test(videoId)) return `${route}?video=${videoId}`
  return route
}

// Tapping a notification focuses an already-open OshiYobi window rather than always opening a new one, so repeated
// notifications don't pile up duplicate windows. With a payload route, the window is moved there (the SPA's own
// route handling takes over); without one, the window is only focused and keeps whatever page it was on.
self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const route = notificationRoute(event.notification.data)
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clientList) => {
      const windows = clientList.filter((client) => "focus" in client)
      const onRoute = route ? windows.find((client) => new URL(client.url).pathname + new URL(client.url).search === route) : null
      const target = onRoute ?? windows[0]
      if (target) {
        if (route && !onRoute) {
          if ("navigate" in target) {
            try {
              const navigated = await target.navigate(route)
              // A refused navigation (null: e.g. an uncontrolled client) is a failure, not a success.
              if (navigated) return navigated.focus()
            } catch {
              // Navigation can be refused or unsupported (some platforms, e.g. an installed iOS app): fall through.
            }
          }
          // The window could not be moved, so open the route directly rather than leave the user on the wrong page. An installed
          // app's own window (where the platform maps it) is reused by the browser; only if even that fails is the old window focused.
          if (self.clients.openWindow) {
            try {
              // A resolved call counts as opened even when it yields null (the spec allows null for a window it cannot hand back); only a
              // rejection (e.g. no user activation) means nothing opened.
              return await self.clients.openWindow(route)
            } catch {
              // openWindow refused: focus the existing window where it is.
            }
          }
        }
        return target.focus()
      }
      if (self.clients.openWindow) return self.clients.openWindow(route ?? "/")
      return undefined
    }),
  )
})
