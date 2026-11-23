/** The query parameters a video notification opens the root Home with: `/?creator=<creatorId>&video=<videoId>` (see notificationRoute in public/sw.js).
 * `creator` names whose Home it is; `video` the exact video to show. */
export const VIDEO_PARAM = "video"
export const CREATOR_PARAM = "creator"

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

/** The raw `creator` value in a location search string (null when absent). */
export function readCreatorParam(search: string): string | null {
  return new URLSearchParams(search).get(CREATOR_PARAM)
}

/** Removes the `video` parameter (and the `creator` parameter that came with it) from the address bar in place (replaceState: no new history
 * entry, history.state and every other part of the URL kept), so a deep link is consumed exactly once -- a later refresh, Back/Forward or unrelated
 * navigation never replays it or its dialog. */
export function stripVideoParam(): void {
  const url = new URL(window.location.href)
  if (!url.searchParams.has(VIDEO_PARAM) && !url.searchParams.has(CREATOR_PARAM)) return
  url.searchParams.delete(VIDEO_PARAM)
  url.searchParams.delete(CREATOR_PARAM)
  window.history.replaceState(window.history.state, "", url)
}
