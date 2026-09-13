import { useCallback } from "react"
import { createSharedState, useSharedState } from "../lib/sharedState"

const STORAGE_KEY = "yobi.mutedNotificationCreatorIds"

function readMuted(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
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

// Module-scoped singleton (see lib/sharedState.ts) — same reasoning as
// useFavoriteCreators: NotificationSettings' own per-creator toggles must
// update instantly for any other mounted consumer, not just after a
// remount.
const mutedStore = createSharedState(STORAGE_KEY, readMuted, serializeMuted)

/** Notification Settings' per-creator push toggle -- tracked as the
 * OPT-OUT set (muted creators), not an on/off map for all ~112, since
 * push is on by default for everyone and only a handful get turned off
 * in the common case. shared app-wide (see mutedStore above), same
 * pattern as useFavoriteCreators. */
export function useMutedNotificationCreators() {
  const [muted, setMuted] = useSharedState(mutedStore)

  const isSubscribed = useCallback((creatorId: string) => !muted.has(creatorId), [muted])

  const toggleSubscribed = useCallback(
    (creatorId: string) => {
      const next = new Set(muted)
      if (next.has(creatorId)) next.delete(creatorId)
      else next.add(creatorId)
      setMuted(next)
    },
    [muted, setMuted],
  )

  return { isSubscribed, toggleSubscribed }
}
