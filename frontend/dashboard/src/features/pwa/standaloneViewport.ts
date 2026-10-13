import { isStandaloneDisplay } from "./installState"

/** The viewport an installed (standalone) OshiYobi gets: no accidental pinch / double-tap scaling. A normal browser tab never gets this --
 * it keeps index.html's own viewport (`width=device-width, initial-scale=1.0`), so zoom and accessibility scaling stay available there. */
export const STANDALONE_VIEWPORT = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"

/** Marks <html data-display-mode="standalone" | "browser">: the one switch every PWA-only CSS rule hangs on (styles/standalone.css), so none
 * of it can apply in a browser tab. */
export const DISPLAY_MODE_ATTRIBUTE = "data-display-mode"

const ORIGINAL_VIEWPORT_ATTRIBUTE = "data-original-content"

function viewportMeta(): HTMLMetaElement | null {
  return document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
}

/** Applies the display mode right now: the attribute on <html>, and the viewport -- locked in standalone, restored to exactly what
 * index.html declared everywhere else. Idempotent. */
export function applyDisplayMode(): void {
  const standalone = isStandaloneDisplay()
  document.documentElement.setAttribute(DISPLAY_MODE_ATTRIBUTE, standalone ? "standalone" : "browser")

  const meta = viewportMeta()
  if (!meta) return
  if (standalone) {
    if (!meta.hasAttribute(ORIGINAL_VIEWPORT_ATTRIBUTE)) meta.setAttribute(ORIGINAL_VIEWPORT_ATTRIBUTE, meta.content)
    meta.content = STANDALONE_VIEWPORT
  } else if (meta.hasAttribute(ORIGINAL_VIEWPORT_ATTRIBUTE)) {
    meta.content = meta.getAttribute(ORIGINAL_VIEWPORT_ATTRIBUTE) ?? meta.content
    meta.removeAttribute(ORIGINAL_VIEWPORT_ATTRIBUTE)
  }
}

/** WebKit's non-standard pinch events. In an installed iOS/iPadOS app they can still start a zoom even with a locked viewport, so they are
 * cancelled -- but ONLY while the app is running standalone (checked at event time), never in a Safari tab. */
function cancelGestureInStandalone(event: Event): void {
  if (isStandaloneDisplay() && event.cancelable) event.preventDefault()
}

let started = false

/** Start-up (main.tsx): applies the display mode, keeps it current if it changes, and installs the standalone-only gesture guard. */
export function startStandaloneViewport(): void {
  if (typeof window === "undefined" || started) return
  started = true
  applyDisplayMode()
  if (typeof window.matchMedia === "function") {
    window.matchMedia("(display-mode: standalone)").addEventListener?.("change", applyDisplayMode)
  }
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, cancelGestureInStandalone, { passive: false })
  }
}

/** Test seam: allow startStandaloneViewport to run again. */
export function resetStandaloneViewportForTests(): void {
  started = false
}
