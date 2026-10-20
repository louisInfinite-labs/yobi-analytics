import { isYouTubeVideoId } from "./videoDeepLinkParam"

/** The outcome of checking one video's CURRENT availability when a notification is opened (never the status it had when the notification was sent).
 *  - available: public, unlisted (reachable by its link), a live/upcoming stream or an archive -- play it; `title` is YouTube's own title when it was returned.
 *  - unavailable: YouTube positively says the video cannot be shown. `private_or_deleted` (oEmbed 404: not found, deleted or private) and `unavailable`
 *    (oEmbed 401: it exists but cannot be shown here, e.g. restricted or not embeddable -- the exact reason is not claimed) are what today's signal can
 *    produce; `members_only` is reserved for a source that can CONFIRM it (the dialog and its text exist, nothing yet produces it --
 *    YouTube's public oEmbed treats a members-only video like any other and so reports it as available, where YouTube's own player explains the restriction).
 *  - unknown: the check itself failed (network error, timeout, rate limit, 5xx, an unrecognised answer). This is never treated as unavailable. */
export type VideoAvailability =
  | { status: "available"; title: string | null }
  | { status: "unavailable"; reason: "private_or_deleted" | "members_only" | "unavailable" }
  | { status: "unknown" }

const OEMBED_URL = "https://www.youtube.com/oembed"
const CHECK_TIMEOUT_MS = 8000

/** Checks one exact video through YouTube's public oEmbed endpoint: no API key, no OshiYobi backend request, no AWS write, no scan, and it never depends
 * on the video being in Recent Videos. 200 = available; 404 = not found, deleted or private; 401 = restricted/not embeddable; anything
 * else (including a thrown fetch or the timeout) = unknown. A malformed id is unavailable without any request. */
export async function checkVideoAvailability(videoId: string, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<VideoAvailability> {
  if (!isYouTubeVideoId(videoId)) return { status: "unavailable", reason: "private_or_deleted" }
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? CHECK_TIMEOUT_MS)
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`
    const response = await fetchImpl(`${OEMBED_URL}?url=${encodeURIComponent(watchUrl)}&format=json`, { signal: controller.signal, credentials: "omit" })
    if (response.status === 404) return { status: "unavailable", reason: "private_or_deleted" }
    if (response.status === 401) return { status: "unavailable", reason: "unavailable" }
    if (!response.ok) return { status: "unknown" }
    const body: unknown = await response.json().catch(() => null)
    const title = body && typeof body === "object" && "title" in body && typeof body.title === "string" && body.title !== "" ? body.title : null
    return { status: "available", title }
  } catch {
    return { status: "unknown" }
  } finally {
    clearTimeout(timer)
  }
}
