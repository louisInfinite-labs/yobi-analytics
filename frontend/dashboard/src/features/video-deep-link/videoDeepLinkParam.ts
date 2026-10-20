/** The query parameter a video notification adds to a creator Home route: `/creator/<slug>?video=<videoId>` (see notificationRoute in public/sw.js). */
export const VIDEO_PARAM = "video"

/** A YouTube video id: exactly 11 characters of [A-Za-z0-9_-]. Anything else is never fetched, embedded or put in a URL. */
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

/** Whether `value` is a well-formed YouTube video id. */
export function isYouTubeVideoId(value: unknown): value is string {
  return typeof value === "string" && YOUTUBE_VIDEO_ID.test(value)
}

/** The raw `video` value in a location search string (null when absent). */
export function readVideoParam(search: string): string | null {
  return new URLSearchParams(search).get(VIDEO_PARAM)
}

/** Removes the `video` parameter from the address bar in place (replaceState: no new history entry, history.state and every other part of the URL kept),
 * so a deep link is consumed exactly once -- a later refresh, Back/Forward or unrelated navigation never replays it or its dialog. */
export function stripVideoParam(): void {
  const url = new URL(window.location.href)
  if (!url.searchParams.has(VIDEO_PARAM)) return
  url.searchParams.delete(VIDEO_PARAM)
  window.history.replaceState(window.history.state, "", url)
}
