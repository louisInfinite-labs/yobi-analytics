/** The smallest slice of YouTube's IFrame Player API the app uses: wrapping an EXISTING embed iframe so its
 * `onStateChange` callback can be observed. The embed must carry `enablejsapi=1` in its src. No second player is
 * ever created and nothing is inferred from the DOM -- playback is only known from this callback. */

const IFRAME_API_SRC = "https://www.youtube.com/iframe_api"

export interface YouTubeStateChangeEvent {
  data: number
}

export interface YouTubeIframeApi {
  Player: new (
    iframe: HTMLIFrameElement,
    options: { events: { onStateChange?: (event: YouTubeStateChangeEvent) => void } },
  ) => unknown
  PlayerState: { PLAYING: number }
}

interface YouTubeWindow {
  YT?: YouTubeIframeApi
  onYouTubeIframeAPIReady?: () => void
}

let apiPromise: Promise<YouTubeIframeApi> | null = null

/** Loads https://www.youtube.com/iframe_api once and resolves with `window.YT`. A load failure (blocked script,
 * offline) rejects and is NOT cached, so a later mount can retry; callers treat a rejection as "playback unknown". */
export function loadYouTubeIframeApi(): Promise<YouTubeIframeApi> {
  if (apiPromise) return apiPromise
  const youtubeWindow = window as unknown as YouTubeWindow

  apiPromise = new Promise<YouTubeIframeApi>((resolve, reject) => {
    if (youtubeWindow.YT?.Player) {
      resolve(youtubeWindow.YT)
      return
    }
    const previousReady = youtubeWindow.onYouTubeIframeAPIReady
    youtubeWindow.onYouTubeIframeAPIReady = () => {
      previousReady?.()
      if (youtubeWindow.YT?.Player) resolve(youtubeWindow.YT)
      else reject(new Error("YouTube IFrame API loaded without a Player"))
    }
    const script = document.createElement("script")
    script.src = IFRAME_API_SRC
    script.async = true
    script.onerror = () => reject(new Error("YouTube IFrame API failed to load"))
    document.head.appendChild(script)
  }).catch((error: unknown) => {
    apiPromise = null
    throw error
  })

  return apiPromise
}

/** Test-only: forgets the cached load so each test starts as if the page had just loaded. */
export function resetYouTubeIframeApiForTests(): void {
  apiPromise = null
}
