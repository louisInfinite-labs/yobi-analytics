import { parseCreatorRoute } from "./creatorRoutes"

const KEY = "yobi.session.homePath"

/** The Home route the user last had in THIS browser session: "/" (the root Home, showing the Oshi/default creator) or an explicit
 * "/creator/:slug". It lives in sessionStorage only: it survives route changes and reloads of the tab, and it ends with the browser session --
 * a new session reads nothing here, so "/" opens the Oshi again. Never localStorage: that would let a previous session's creator outlive it. */
export function readSessionHomePath(): string {
  try {
    const raw = window.sessionStorage.getItem(KEY)
    if (raw && parseCreatorRoute(raw)?.kind === "creator") return raw
  } catch {
    // Treated as the root Home below.
  }
  return "/"
}

/** Records the Home route being shown ("/" or a valid creator path). Anything else is ignored. */
export function writeSessionHomePath(pathname: string): void {
  if (pathname !== "/" && parseCreatorRoute(pathname)?.kind !== "creator") return
  try {
    window.sessionStorage.setItem(KEY, pathname)
  } catch {
    // Best effort: without it Home simply returns to the root Home.
  }
}
