import { useCallback } from "react"
import { createSharedState, useSharedState } from "../lib/sharedState"

const STORAGE_KEY = "yobi.favoriteCreatorIds"

function readFavorites(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === "string")) : new Set()
  } catch {
    return new Set()
  }
}

function serializeFavorites(favorites: Set<string>): string {
  return JSON.stringify([...favorites])
}

// Module-scoped singleton (see lib/sharedState.ts) — required before
// swipe-to-favorite (Task 2): any component's toggle must be visible to
// every other mounted CreatorStatusList (avatar heart, favorites view,
// live/offline counts, ...) immediately, not just after a remount.
const favoritesStore = createSharedState(STORAGE_KEY, readFavorites, serializeFavorites)

/** "My Favorites" — the user's own hand-picked subset of creators they
 * actually want to keep an eye on, shared app-wide (see favoritesStore above)
 * via the same underlying store, not a per-view favorites list. */
export function useFavoriteCreators() {
  const [favorites, setFavorites] = useSharedState(favoritesStore)

  const toggleFavorite = useCallback(
    (channelId: string) => {
      const next = new Set(favorites)
      if (next.has(channelId)) next.delete(channelId)
      else next.add(channelId)
      setFavorites(next)
    },
    [favorites, setFavorites],
  )

  return { favorites, toggleFavorite }
}
