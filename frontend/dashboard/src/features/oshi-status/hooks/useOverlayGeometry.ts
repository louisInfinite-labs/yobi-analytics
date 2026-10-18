import { useLayoutEffect, useState, type RefObject } from "react"
import { computeOverlayGeometry, type OverlayGeometry } from "../model/milestoneOverlayGeometry"

/** The overlay rectangle measured from the rendered panel and its Now Playing region while `active`, re-measured whenever either one resizes or the
 * window does (rotation, breakpoint change, a wrapping title). The Now Playing region is always rendered with a fixed structure whatever the
 * livestream or network state, so its rectangle -- and therefore the overlay -- is the same in every state. Null until measured, never a guessed size. */
export function useOverlayGeometry(
  active: boolean,
  panelRef: RefObject<HTMLElement | null>,
  nowPlayingRef: RefObject<HTMLElement | null>,
): OverlayGeometry | null {
  const [geometry, setGeometry] = useState<OverlayGeometry | null>(null)

  useLayoutEffect(() => {
    if (!active) return
    const panel = panelRef.current
    const nowPlaying = nowPlayingRef.current
    if (!panel || !nowPlaying) {
      setGeometry(null)
      return
    }

    const measure = () => {
      const nowPlayingRect = nowPlaying.getBoundingClientRect()
      const next = computeOverlayGeometry({
        panel: panel.getBoundingClientRect(),
        panelBorderTop: panel.clientTop,
        panelBorderLeft: panel.clientLeft,
        nowPlaying: { top: nowPlayingRect.top, bottom: nowPlayingRect.bottom },
      })
      setGeometry((previous) =>
        previous && previous.top === next.top && previous.left === next.left && previous.width === next.width && previous.height === next.height ? previous : next,
      )
    }

    measure()
    window.addEventListener("resize", measure)
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    observer?.observe(panel)
    observer?.observe(nowPlaying)
    return () => {
      window.removeEventListener("resize", measure)
      observer?.disconnect()
    }
  }, [active, panelRef, nowPlayingRef])

  return active ? geometry : null
}