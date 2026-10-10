import { useEffect, useState, type RefObject } from "react"
import { markWatchedDuringLive } from "../../../shared/newContent/newContentTracking"
import { loadYouTubeIframeApi } from "../utils/youtubeIframeApi"

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
    let cancelled = false

    loadYouTubeIframeApi()
      .then((api) => {
        if (cancelled) return
        // Wraps the existing iframe; deliberately never destroy()ed, since that would remove an element React owns.
        new api.Player(iframe, {
          events: {
            onStateChange: (event) => {
              if (!cancelled) setPlayingVideoId(event.data === api.PlayerState.PLAYING ? videoId : null)
            },
          },
        })
      })
      .catch(() => {
        // No IFrame API: playback can never be confirmed, so nothing is recorded.
      })

    return () => {
      cancelled = true
    }
  }, [iframeRef, videoId, tracking])

  const playing = playingVideoId === videoId
  useEffect(() => {
    if (tracking && isLive && playing) markWatchedDuringLive(videoId)
  }, [tracking, isLive, playing, videoId])
}
