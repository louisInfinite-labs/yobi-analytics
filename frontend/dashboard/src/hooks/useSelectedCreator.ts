import { useCallback, useState } from "react"
import { mockCreators } from "../data/mockCreators"

const STORAGE_KEY = "yobi.home.selectedCreatorId"

function isKnownCreator(creatorId: string): boolean {
  return mockCreators.some((creator) => creator.channelId === creatorId)
}

function readSelectedCreator(): string {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw && isKnownCreator(raw)) return raw
  } catch {
    // Fall through to the default below.
  }
  return mockCreators[0].channelId
}

/** The Home page's single "which creator's room is this" selection —
 * persisted like every other lightweight Home setting (localStorage), not
 * held in the shared Holodex/analytics state (spec's own state-boundary
 * table keeps "selected creator" in localStorage, separate from the shared
 * cache other views read). */
export function useSelectedCreator() {
  const [creatorId, setCreatorIdState] = useState<string>(readSelectedCreator)

  const setCreatorId = useCallback((next: string) => {
    setCreatorIdState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Best-effort, matching every other Home setting's own reasoning.
    }
  }, [])

  return [creatorId, setCreatorId] as const
}
