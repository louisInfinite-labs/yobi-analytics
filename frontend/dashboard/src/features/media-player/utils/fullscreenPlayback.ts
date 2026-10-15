/** Best-effort fullscreen playback for a touch device: ask the browser to fullscreen the player, then (only once that has succeeded) to lock the
 * screen to landscape. Every step is progressive enhancement -- an unsupported API, a rejected request or an OS rotation lock never stops the
 * player: the caller simply keeps its normal responsive (portrait) layout. The user's own OS rotation lock and accessibility settings win:
 * nothing here rotates the page with CSS, and a lock the OS refuses is left refused. */

/** `ScreenOrientation.lock`/`unlock` are not in the DOM lib's types (not every engine ships them), so they are reached through this shape. */
interface LockableOrientation {
  lock?: (orientation: "landscape") => Promise<void>
  unlock?: () => void
}

type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }
type FullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void }

export interface FullscreenOutcome {
  /** The browser put the player in fullscreen. */
  fullscreen: boolean
  /** The screen is now locked to landscape (only ever true after fullscreen succeeded). */
  orientationLocked: boolean
}

/** A touch-first device (the primary pointer is a finger): the only kind that is ever sent into automatic fullscreen. A desktop keeps the
 * ordinary modal, including a desktop with a touch screen whose primary pointer is still the mouse. */
export function isTouchDevice(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches
}

/** Whatever element is fullscreen right now (standard or WebKit-prefixed), or null. */
export function currentFullscreenElement(): Element | null {
  const doc = document as FullscreenDocument
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null
}

function orientationApi(): LockableOrientation | null {
  return typeof screen === "undefined" ? null : ((screen as unknown as { orientation?: LockableOrientation }).orientation ?? null)
}

/** Releases a landscape lock this module took. Safe to call when nothing is locked or the API does not exist. */
export function unlockOrientation(): void {
  try {
    orientationApi()?.unlock?.()
  } catch {
    // An engine that throws on unlock has nothing locked for us to release.
  }
}

/** Asks for fullscreen on `element` and, if that is granted, for a landscape lock.
 *
 * The fullscreen request is made SYNCHRONOUSLY when this is called (before any await): browsers only grant it from a user gesture, and a
 * request deferred behind unrelated async work would lose that activation. So the caller must call this from inside the tap that opened the
 * player. Never rejects: every refusal resolves to the outcome the caller can fall back from. */
export async function enterFullscreenPlayback(element: HTMLElement): Promise<FullscreenOutcome> {
  const target = element as FullscreenElement
  const request = target.requestFullscreen ?? target.webkitRequestFullscreen
  if (!request) return { fullscreen: false, orientationLocked: false }
  try {
    await request.call(target)
  } catch {
    return { fullscreen: false, orientationLocked: false }
  }

  const orientation = orientationApi()
  if (!orientation?.lock) return { fullscreen: true, orientationLocked: false }
  try {
    await orientation.lock("landscape")
    return { fullscreen: true, orientationLocked: true }
  } catch {
    return { fullscreen: true, orientationLocked: false }
  }
}

/** Undoes enterFullscreenPlayback: unlocks the orientation and leaves fullscreen if `element` (or something inside it) is the fullscreen element.
 * A fullscreen that something else owns is left alone. */
export function leaveFullscreenPlayback(element: HTMLElement | null): void {
  unlockOrientation()
  const fullscreenElement = currentFullscreenElement()
  if (!element || !fullscreenElement || !element.contains(fullscreenElement)) return
  const doc = document as FullscreenDocument
  try {
    const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen
    void Promise.resolve(exit?.call(doc)).catch(() => {})
  } catch {
    // Leaving a fullscreen the engine already dropped throws in some browsers; the state is clean either way.
  }
}
