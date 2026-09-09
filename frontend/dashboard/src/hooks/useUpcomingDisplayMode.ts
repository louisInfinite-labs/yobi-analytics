import { useCallback, useState } from "react"
import type { UpcomingDisplayMode } from "../lib/creatorStatusFormat"

const STORAGE_KEY = "yobi.upcomingDisplayMode"

function readMode(): UpcomingDisplayMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw === "countdown" ? "countdown" : "absolute"
  } catch {
    return "absolute"
  }
}

/** The one global "upcoming time display" setting (spec: "Do not create
 * separate Home and Dock status logic; use one formatter/view model") —
 * every consumer of creator status shares this same preference. */
export function useUpcomingDisplayMode() {
  const [mode, setModeState] = useState<UpcomingDisplayMode>(readMode)

  const setMode = useCallback((next: UpcomingDisplayMode) => {
    setModeState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Best-effort, matching every other Home/Dock setting's own reasoning.
    }
  }, [])

  return [mode, setMode] as const
}
