import { useEffect, type RefObject } from "react"
import { attachIframePlayer, YT_STATE, type IframePlayer } from "../utils/iframePlayer"
import { dueAttempt, msUntilNextAttempt } from "../utils/upcomingStartRecovery"

/** States in which the embedded player has moved on from the waiting room (or the viewer has taken over) -- it is never touched again. */
const SETTLED_STATES: ReadonlySet<number> = new Set([YT_STATE.PLAYING, YT_STATE.BUFFERING, YT_STATE.PAUSED, YT_STATE.ENDED])

/** Gets an ALREADY-OPEN embed past YouTube's waiting screen when the broadcast it was opened for begins, without a page refresh.
 *
 * The embed keeps the exact same videoId and the same iframe (never re-keyed or re-sourced, so nothing remounts and Home, the selected Oshi, Topic, search
 * and scroll position are untouched). YouTube's own waiting room usually starts the stream by itself; this only steps in if, at the bounded moments after
 * the scheduled start (upcomingStartRecovery.ts), the player is STILL on the waiting screen (UNSTARTED/CUED). It then asks the SAME player to take the SAME
 * videoId again -- `loadVideoById` where autoplay is allowed (desktop, already muted), `cueVideoById` otherwise (phones: never an autoplay attempt, the
 * viewer taps play as before). A playing, buffering, paused or ended player is never touched, so nothing the viewer did is interrupted.
 *
 * It claims nothing: whether the stream is LIVE stays the app's own status. It makes no network request of its own (the player talks to YouTube, as
 * it already does), the attempts are finite, and a background tab only catches up ONCE when it becomes visible (timers are suspended there; the
 * visibility/focus/pageshow/online events re-evaluate from the wall clock). `scheduledStartMs === null` (not a scheduled stream) turns it off. */
export function useUpcomingStartRecovery(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  videoId: string,
  scheduledStartMs: number | null,
  options: { autoplay: boolean },
): void {
  const { autoplay } = options
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || scheduledStartMs === null) return
    const startMs = scheduledStartMs
    const mountedAt = Date.now()
    let attemptsDone = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let player: IframePlayer | null = null

    const { player: playerPromise, detach } = attachIframePlayer(iframe)
    playerPromise
      .then((resolved) => {
        if (stopped) return
        player = resolved
        evaluate()
      })
      .catch(() => {
        // No IFrame API: nothing can be observed or asked of the player, so nothing is attempted.
      })

    function schedule() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (stopped || !player || document.visibilityState === "hidden") return // a hidden tab's timers are suspended anyway; becoming visible re-evaluates
      const wait = msUntilNextAttempt({ now: Date.now(), startMs, mountedAt, attemptsDone })
      if (wait !== null) timer = setTimeout(evaluate, wait)
    }

    function evaluate() {
      if (stopped || document.visibilityState === "hidden") return
      const { due, nextAttemptsDone } = dueAttempt({ now: Date.now(), startMs, mountedAt, attemptsDone })
      if (due && player) {
        attemptsDone = nextAttemptsDone
        recover(player)
      }
      schedule()
    }

    function recover(current: IframePlayer) {
      // Only the player this hook was created for, still showing this very video, and still sitting on the waiting screen.
      const playerVideoId = current.getVideoData?.().video_id
      if (!iframe!.isConnected || (playerVideoId !== undefined && playerVideoId !== videoId)) return
      const state = current.getPlayerState?.() ?? YT_STATE.PLAYING // an unreadable state is treated as "do not touch"
      if (SETTLED_STATES.has(state)) {
        if (state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING) attemptsDone = Number.MAX_SAFE_INTEGER // it started by itself: done for good
        return
      }
      if (autoplay) current.loadVideoById?.(videoId)
      else current.cueVideoById?.(videoId)
    }

    const wake = () => evaluate()
    document.addEventListener("visibilitychange", wake)
    window.addEventListener("pageshow", wake)
    window.addEventListener("focus", wake)
    window.addEventListener("online", wake)
    schedule()

    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener("visibilitychange", wake)
      window.removeEventListener("pageshow", wake)
      window.removeEventListener("focus", wake)
      window.removeEventListener("online", wake)
      detach()
    }
  }, [iframeRef, videoId, scheduledStartMs, autoplay])
}
