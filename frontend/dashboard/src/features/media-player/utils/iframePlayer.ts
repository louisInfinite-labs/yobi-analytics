import { loadYouTubeIframeApi } from "./youtubeIframeApi"

/** YT.PlayerState values (fixed by the IFrame API): the only ones this app reasons about. */
export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const

/** The slice of a YT.Player instance this app calls. */
export interface IframePlayer {
  getPlayerState?: () => number
  getVideoData?: () => { video_id?: string }
  loadVideoById?: (videoId: string) => void
  cueVideoById?: (videoId: string) => void
}

type StateListener = (state: number) => void

interface Entry {
  player: Promise<IframePlayer>
  listeners: Set<StateListener>
}

const entries = new WeakMap<HTMLIFrameElement, Entry>()

/** Wraps an EXISTING embed iframe (enablejsapi=1) in a YT.Player exactly once, however many features observe it: every later caller shares that one
 * player, so there is never a second player on the same iframe. `onState` receives every state change until the returned `detach` is called; the
 * resolved player is the live YT.Player, resolved once it is ready. The player is deliberately
 * never destroy()ed, since that would remove an element React owns. A load failure rejects (callers treat it as "playback unknown"). */
export function attachIframePlayer(iframe: HTMLIFrameElement, onState?: StateListener): { player: Promise<IframePlayer>; detach: () => void } {
  let entry = entries.get(iframe)
  if (!entry) {
    const listeners = new Set<StateListener>()
    // Resolves once the player's methods are callable (its onReady), so a caller never has to guess whether getPlayerState() exists yet.
    const player = loadYouTubeIframeApi().then(
      (api) =>
        new Promise<IframePlayer>((resolve) => {
          const created = new api.Player(iframe, {
            events: {
              onReady: () => resolve(created),
              onStateChange: (event) => listeners.forEach((listener) => listener(event.data)),
            },
          }) as IframePlayer
          if (typeof created.getPlayerState === "function") resolve(created)
        }),
    )
    entry = { player, listeners }
    entries.set(iframe, entry)
  }
  const { listeners, player } = entry
  if (onState) listeners.add(onState)
  return { player, detach: () => void (onState && listeners.delete(onState)) }
}
