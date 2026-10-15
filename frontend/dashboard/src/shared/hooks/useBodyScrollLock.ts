import { useEffect } from "react"

/** How many full-screen overlays currently hold the lock, and the page's own inline overflow styles to give back when the last one lets go. */
let holders = 0
let saved: { html: string; overscroll: string } | null = null

/** Stops the page behind a full-screen overlay from scrolling while `locked` is true (Live Status as a full sheet, the fullscreen player).
 *
 * `overflow: hidden` on <html> ONLY keeps the scroll position exactly where it was (nothing jumps on open or close) and, on a phone or
 * tablet, whose scrollbars are overlays, changes no layout width. It must not also be set on <body>: with both set, Chrome resets the page
 * to the top (measured in a real browser). Reference-counted, so two overlays open at once release the page only when the last one closes;
 * the page's own inline styles are restored byte for byte. The overlay's own scrolling areas are unaffected. */
export function useBodyScrollLock(locked: boolean): void {
  useEffect(() => {
    if (!locked) return
    const html = document.documentElement
    if (holders === 0) {
      saved = { html: html.style.overflow, overscroll: html.style.overscrollBehavior }
      html.style.overflow = "hidden"
      html.style.overscrollBehavior = "none"
    }
    holders += 1
    return () => {
      holders -= 1
      if (holders === 0 && saved) {
        html.style.overflow = saved.html
        html.style.overscrollBehavior = saved.overscroll
        saved = null
      }
    }
  }, [locked])
}
