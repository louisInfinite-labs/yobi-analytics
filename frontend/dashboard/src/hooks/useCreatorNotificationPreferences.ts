import { useCallback } from "react"
import { createSharedState, useSharedState } from "../lib/sharedState"

const LIVE_STORAGE_KEY = "yobi.mutedLiveNotificationCreatorIds"
const NEW_VIDEO_STORAGE_KEY = "yobi.mutedNewVideoNotificationCreatorIds"

function readMuted(storageKey: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === "string")) : new Set()
  } catch {
    return new Set()
  }
}

function serializeMuted(muted: Set<string>): string {
  return JSON.stringify([...muted])
}

// Module-scoped singletons (see lib/sharedState.ts) — same reasoning as
// useFavoriteCreators: every mounted consumer must update instantly, not
// just after a remount. Two independent stores (live vs. new video), each
// its own opt-out set, replacing this feature's earlier single
// useMutedNotificationCreators (one toggle) model, which the "two
// independent switches per creator" requirement no longer fits.
const liveMutedStore = createSharedState(LIVE_STORAGE_KEY, () => readMuted(LIVE_STORAGE_KEY), serializeMuted)
const newVideoMutedStore = createSharedState(NEW_VIDEO_STORAGE_KEY, () => readMuted(NEW_VIDEO_STORAGE_KEY), serializeMuted)

/** Notification Settings' two independent per-creator push toggles --
 * live-stream notifications and new-video notifications -- each tracked
 * as its own OPT-OUT set (muted creators), not an on/off map for all
 * ~112, since both are on by default and only a handful get turned off
 * in the common case. Shared app-wide (see the two stores above), same
 * pattern as useFavoriteCreators.
 *
 * setLiveSubscribed/setNewVideoSubscribed take the target `subscribed`
 * value explicitly (not a blind toggle), so each Switch stays a
 * controlled component driven straight from its own `onChange(checked)`
 * callback rather than inferring the next state itself. */
export function useCreatorNotificationPreferences() {
  const [liveMuted, setLiveMuted] = useSharedState(liveMutedStore)
  const [newVideoMuted, setNewVideoMuted] = useSharedState(newVideoMutedStore)

  const isLiveSubscribed = useCallback((creatorId: string) => !liveMuted.has(creatorId), [liveMuted])
  const isNewVideoSubscribed = useCallback((creatorId: string) => !newVideoMuted.has(creatorId), [newVideoMuted])

  const setLiveSubscribed = useCallback(
    (creatorId: string, subscribed: boolean) => {
      const next = new Set(liveMuted)
      if (subscribed) next.delete(creatorId)
      else next.add(creatorId)
      setLiveMuted(next)
    },
    [liveMuted, setLiveMuted],
  )

  const setNewVideoSubscribed = useCallback(
    (creatorId: string, subscribed: boolean) => {
      const next = new Set(newVideoMuted)
      if (subscribed) next.delete(creatorId)
      else next.add(creatorId)
      setNewVideoMuted(next)
    },
    [newVideoMuted, setNewVideoMuted],
  )

  return { isLiveSubscribed, isNewVideoSubscribed, setLiveSubscribed, setNewVideoSubscribed }
}
