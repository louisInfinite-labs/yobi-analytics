import { createSharedState, useSharedState } from "../lib/sharedState"
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

// Module-scoped singleton (see lib/sharedState.ts) — every useCountdownLanguage()
// call in this tab shares this one store, so a language change from
// UpcomingDisplaySettings updates every other already-mounted Home/Dock
// consumer immediately instead of only agreeing at each one's own mount time
// (CodeRabbit: per-instance useState left mounted consumers on the old
// language after a change elsewhere).
const countdownLanguageStore = createSharedState<CountdownLanguage>(STORAGE_KEY, readLanguage, (value) => value)

/** The countdown label's own language — a separate setting from
 * UpcomingDisplayMode (absolute-vs-countdown); this only affects what the
 * countdown text reads once that mode is selected. */
export function useCountdownLanguage() {
  return useSharedState(countdownLanguageStore)
}
