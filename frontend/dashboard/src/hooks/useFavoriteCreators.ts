import { useCallback, useState } from "react"

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

function writeFavorites(favorites: Set<string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...favorites]))
  } catch {
    // Best-effort, matching every other Home/Dock setting's own reasoning.
  }
}

/** "我的收藏" — the user's own hand-picked subset of creators they actually
 * want to keep an eye on, shared by every surface that lists creators
 * (global Dock, Home's ListStatus panel) via the same underlying set, not
 * a per-view favorites list. */
export function useFavoriteCreators() {
  const [favorites, setFavorites] = useState<Set<string>>(readFavorites)

  const toggleFavorite = useCallback((channelId: string) => {
    setFavorites((prev) => {
      const next = new Set(prev)
      if (next.has(channelId)) next.delete(channelId)
      else next.add(channelId)
      writeFavorites(next)
      return next
    })
  }, [])

  return { favorites, toggleFavorite }
}
