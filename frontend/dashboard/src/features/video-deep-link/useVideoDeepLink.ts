import { useCallback, useEffect, useRef, useState } from "react"
import { resolveCreatorKey } from "../../entities/creator/data/creatorRegistry"
import { parseCreatorRoute } from "../../app/navigation/creatorRoutes"
import { checkVideoAvailability, type VideoAvailability } from "./videoAvailability"
import { isYouTubeVideoId, readVideoParam, stripVideoParam } from "./videoDeepLinkParam"

export type VideoDeepLinkDialogKind = "members_only" | "private_or_deleted" | "unavailable" | "unknown"

interface Target {
  videoId: string
  /** The canonical creatorId the URL named (`/creator/<slug>`). */
  creatorId: string
}

interface DeepLinkOptions {
  /** The creator Home currently showing (the same id HomePage uses). A result for another creator is dropped, never applied. */
  currentCreatorId: string
  /** Shows the video in Home's central player exactly like a deliberate pick from the shelf (HomePage's openVideo: selects it, scrolls to the player, and
   * applies the existing NEW rules). Called with the video's own id and YouTube's title when it has one. */
  openVideo: (video: { videoId: string; title: string }) => void
  /** The video id Home's player is showing from a deliberate pick (null when none). Once it changes to a video other than the linked one, the viewer has
   * moved on and the parameter is released, so a later refresh shows what they chose rather than the stale link. */
  selectedVideoId?: string | null
  /** Injection point for tests; defaults to the oEmbed check. */
  check?: (videoId: string) => Promise<VideoAvailability>
}

/** Consumes a `?video=<id>` deep link on a creator Home (the service worker's video notification route). It reads the id on mount and on every
 * popstate, checks the video's CURRENT availability, and then either opens that exact video or raises a dialog:
 *  - available (public, unlisted, live, archive; whether or not it is in Recent Videos) -> openVideo.
 *  - unavailable -> the creator Home stays as it is and a dialog explains why.
 *  - unknown (the check failed) -> a dialog with Retry; never reported as private.
 * The parameter stays in the address bar, so refreshing or re-opening the URL selects the same video again. It is released (replaceState) when the viewer
 * dismisses a dialog or deliberately selects another video. A malformed id, or a `video` parameter on anything but a valid creator route, is ignored and
 * removed. Nothing here writes the default Oshi or any stored preference. */
export function useVideoDeepLink({ currentCreatorId, openVideo, selectedVideoId = null, check = checkVideoAvailability }: DeepLinkOptions) {
  const [dialog, setDialog] = useState<{ kind: VideoDeepLinkDialogKind; target: Target } | null>(null)
  const latest = useRef({ currentCreatorId, openVideo, check })
  useEffect(() => {
    latest.current = { currentCreatorId, openVideo, check } // the newest callbacks, for the async check below
  })
  const mounted = useRef(false)
  const sequence = useRef(0)

  const run = useCallback(async (target: Target) => {
    const ticket = ++sequence.current
    const result = await latest.current.check(target.videoId)
    if (!mounted.current || ticket !== sequence.current) return // superseded by a newer link, a retry or a dismissal
    if (result.status === "available") {
      setDialog(null)
      // The viewer moved to another creator while the check ran: the link no longer applies, so nothing is selected.
      if (resolveCreatorKey(latest.current.currentCreatorId)?.creatorId !== target.creatorId) return
      latest.current.openVideo({ videoId: target.videoId, title: result.title ?? "YouTube video" })
      return
    }
    setDialog({ kind: result.status === "unavailable" ? result.reason : "unknown", target })
  }, [])

  useEffect(() => {
    mounted.current = true
    const consume = () => {
      const raw = readVideoParam(window.location.search)
      if (raw === null) return
      const route = parseCreatorRoute(window.location.pathname)
      if (!isYouTubeVideoId(raw) || route?.kind !== "creator") {
        stripVideoParam()
        return
      }
      void run({ videoId: raw, creatorId: route.creator.creatorId })
    }
    consume()
    window.addEventListener("popstate", consume)
    return () => {
      mounted.current = false
      window.removeEventListener("popstate", consume)
    }
  }, [run])

  const previousSelection = useRef(selectedVideoId)
  useEffect(() => {
    const before = previousSelection.current
    previousSelection.current = selectedVideoId
    if (selectedVideoId === null || selectedVideoId === before) return
    const linked = readVideoParam(window.location.search)
    if (linked === null || linked === selectedVideoId) return
    sequence.current += 1 // a check still in flight must not later replace the viewer's pick with the linked video
    stripVideoParam() // the viewer picked another video: the link has been superseded
  }, [selectedVideoId])

  const dismiss = useCallback(() => {
    sequence.current += 1 // a check still in flight must not reopen what was just closed
    setDialog(null)
    stripVideoParam() // a closed explanation must not come back on refresh
  }, [])
  const retry = useCallback(() => {
    if (!dialog) return
    const { target } = dialog
    setDialog(null)
    void run(target)
  }, [dialog, run])

  return { dialog: dialog?.kind ?? null, retry, dismiss }
}
