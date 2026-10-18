import { useEffect, useState } from "react"
import { JST_OFFSET_MS } from "../../features/oshi-status/model/milestoneCountdown"

const DAY_MS = 24 * 60 * 60 * 1000

/** The absolute instant of 00:00:00 JST of the JST calendar day that contains `epochMs`. */
export function jstDayStartMs(epochMs: number): number {
  return Math.floor((epochMs + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS
}

/** The start (00:00:00 JST) of the CURRENT JST calendar day. The component re-renders only when that day changes -- one timer aimed at the next JST
 * midnight, never a per-second tick -- and the value is re-read from the clock the moment the tab becomes visible again, the window regains focus, or the
 * page is restored from the back-forward cache (background timers are throttled, so a day change may have been missed). Independent of the browser zone. */
export function useJstDayStart(): number {
  const [dayStart, setDayStart] = useState(() => jstDayStartMs(Date.now()))

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
    const sync = () => {
      stop()
      const now = Date.now()
      setDayStart(jstDayStartMs(now))
      if (document.visibilityState === "hidden") return
      // Aimed just after the next JST midnight, from the absolute clock (no accumulated drift).
      timer = setTimeout(sync, jstDayStartMs(now) + DAY_MS - now + 50)
    }
    sync()
    document.addEventListener("visibilitychange", sync)
    window.addEventListener("focus", sync)
    window.addEventListener("pageshow", sync)
    return () => {
      stop()
      document.removeEventListener("visibilitychange", sync)
      window.removeEventListener("focus", sync)
      window.removeEventListener("pageshow", sync)
    }
  }, [])

  return dayStart
}