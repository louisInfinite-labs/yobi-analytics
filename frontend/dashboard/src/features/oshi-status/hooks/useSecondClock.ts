import { useEffect, useState } from "react"

/** The current time in ms, re-read once per second while `active` -- and not at all otherwise (no timer exists while the dialog is closed).
 * Each tick is scheduled to land just after the next WALL-CLOCK second boundary from Date.now(), instead of a fixed 1000 ms interval, so the
 * display never drifts, and the value is always a fresh Date.now(), never an accumulated count or a cached remaining time.
 *
 * Browsers throttle or freeze timers in a background tab, so ticking stops while the page is hidden, and the moment the tab becomes visible
 * again (or the window regains focus / is restored from the back-forward cache) the time is re-read at once and the one-second schedule restarts:
 * the countdown shows the true remaining time immediately, never the value it had when the tab was left. */
export function useSecondClock(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
    const schedule = () => {
      stop()
      timer = setTimeout(() => {
        setNowMs(Date.now())
        schedule()
      }, 1000 - (Date.now() % 1000) + 5)
    }
    const resync = () => {
      if (document.visibilityState === "hidden") {
        stop()
        return
      }
      setNowMs(Date.now())
      schedule()
    }

    if (document.visibilityState !== "hidden") schedule()
    document.addEventListener("visibilitychange", resync)
    window.addEventListener("focus", resync)
    window.addEventListener("pageshow", resync)
    return () => {
      stop()
      document.removeEventListener("visibilitychange", resync)
      window.removeEventListener("focus", resync)
      window.removeEventListener("pageshow", resync)
    }
  }, [active])

  return nowMs
}