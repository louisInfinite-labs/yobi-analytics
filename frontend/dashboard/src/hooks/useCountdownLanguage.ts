import { useCallback, useState } from "react"
import type { CountdownLanguage } from "../lib/creatorStatusFormat"

const STORAGE_KEY = "yobi.countdownLanguage"

/** navigator.language-based default (zh/ja prefix, else English) — the
 * user's explicit choice below always takes over once saved. */
function detectDefaultLanguage(): CountdownLanguage {
  const lang = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase()
  if (lang.startsWith("zh")) return "zh"
  if (lang.startsWith("ja")) return "ja"
  return "en"
}

function readLanguage(): CountdownLanguage {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === "zh" || raw === "en" || raw === "ja") return raw
  } catch {
    // Fall through to the detected default below.
  }
  return detectDefaultLanguage()
}

/** The countdown label's own language — a separate setting from
 * UpcomingDisplayMode (absolute-vs-countdown); this only affects what the
 * countdown text reads once that mode is selected. */
export function useCountdownLanguage() {
  const [language, setLanguageState] = useState<CountdownLanguage>(readLanguage)

  const setLanguage = useCallback((next: CountdownLanguage) => {
    setLanguageState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Best-effort, matching every other Home/Dock setting's own reasoning.
    }
  }, [])

  return [language, setLanguage] as const
}
