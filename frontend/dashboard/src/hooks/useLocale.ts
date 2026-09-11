import { createSharedState, useSharedState } from "../lib/sharedState"
import type { Locale } from "../i18n/translations"

const STORAGE_KEY = "yobi.locale"

/** navigator.language-based default — mirrors useCountdownLanguage's own
 * detection, mapped onto the three prepared locales. */
function detectDefaultLocale(): Locale {
  const lang = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase()
  if (lang.startsWith("zh")) return "zh-TW"
  if (lang.startsWith("ja")) return "ja"
  return "en"
}

function readLocale(): Locale {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === "zh-TW" || raw === "en" || raw === "ja") return raw
  } catch {
    // Fall through to the detected default below.
  }
  return detectDefaultLocale()
}

// Module-scoped singleton (see lib/sharedState.ts) — no language-settings UI
// calls setLocale yet (out of scope for now), but whichever future one does
// will update every mounted consumer in this tab immediately rather than
// only after a remount.
const localeStore = createSharedState<Locale>(STORAGE_KEY, readLocale, (value) => value)

/** The app-wide locale for newly added user-facing text (this session's own
 * "future UI features should follow the same rule" requirement), shared
 * app-wide (see localeStore above). No language-settings UI exists yet to
 * change this — out of this task's scope — so today it only auto-detects
 * from the browser; `setLocale` is ready for whichever future settings UI
 * needs it. */
export function useLocale() {
  return useSharedState(localeStore)
}
