import { resolveCreatorKey, toLegacyRosterId } from "../../entities/creator/data/creatorRegistry"

const KEY = "yobi.session.homeCreator"

/** The creator Home was switched to in THIS browser session (legacy roster id, e.g. "ch_aizawa_ema"), or null when the session has not switched
 * (Home then shows the Oshi). sessionStorage only: it survives route changes and reloads of the tab and ends with the browser session, so a new
 * session always starts from the Oshi. Never localStorage: a previous session's pick must not outlive it. A value that is no longer a known
 * creator reads as null. */
export function readSessionCreatorId(): string | null {
  try {
    const raw = window.sessionStorage.getItem(KEY)
    const creator = raw ? resolveCreatorKey(raw) : undefined
    return creator ? toLegacyRosterId(creator) : null
  } catch {
    return null
  }
}

/** Records the creator the session switched to; null forgets it (Home goes back to the Oshi). */
export function writeSessionCreatorId(creatorId: string | null): void {
  try {
    if (creatorId === null) window.sessionStorage.removeItem(KEY)
    else window.sessionStorage.setItem(KEY, creatorId)
  } catch {
    // Best effort: without it a reload simply shows the Oshi.
  }
}
