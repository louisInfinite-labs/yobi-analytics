import { useEffect, useState, type RefObject } from "react"
import { markWatchedDuringLive } from "../../../shared/newContent/newContentTracking"
import { attachIframePlayer, YT_STATE } from "../utils/iframePlayer"

/** Records "watched during the live session" for the video in `iframeRef`'s YouTube embed -- but ONLY once the
 * embedded player's own `onStateChange` callback reports PLAYING for it (the first PLAYING is enough; there is no
 * minimum watch time) AND the app's live status says that same videoId is live right now.
 *
 * Nothing else counts: the page opening, the creator being the main Oshi, the creator being auto-selected, the
 * iframe existing, a videoId being assigned or an autoplay being attempted never record anything. If the
 * IFrame API fails to load, autoplay is blocked, or the state is anything but PLAYING, nothing is recorded -- an
 * unknown playback state always means NOT watched (showing NEW later beats wrongly hiding it).
 *
 * `isLive === undefined` turns tracking off entirely (the API is not even loaded). The embed's src must include
 * `enablejsapi=1`. Re-rendering the iframe for a different video must remount it (key={videoId}) so a fresh
 * player is wrapped; both effects re-evaluate per videoId. A PLAYING that arrives just before the live status
 * flips to live is still recorded, because the two conditions are combined here, not at callback time. */
export function useWatchedDuringLive(iframeRef: RefObject<HTMLIFrameElement | null>, videoId: string, isLive: boolean | undefined): void {
  const tracking = isLive !== undefined
  const [playingVideoId, setPlayingVideoId] = useState<string | null>(null)

  useEffect(() => {
    const iframe = iframeRef.current
    if (!tracking || !iframe) return
    // The one shared player for this iframe (iframePlayer.ts): other features observing the same embed never create a second one.
    const { player, detach } = attachIframePlayer(iframe, (state) => setPlayingVideoId(state === YT_STATE.PLAYING ? videoId : null))
    player.catch(() => {
      // No IFrame API: playback can never be confirmed, so nothing is recorded.
    })

    return detach
  }, [iframeRef, videoId, tracking])

  const playing = playingVideoId === videoId
  useEffect(() => {
    if (tracking && isLive && playing) markWatchedDuringLive(videoId)
  }, [tracking, isLive, playing, videoId])
}
