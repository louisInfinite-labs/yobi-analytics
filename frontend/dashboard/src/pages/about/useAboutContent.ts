import { useEffect } from "react"
import { useSharedState } from "../../shared/state/sharedState"
import { aboutContentStore, ensureAboutContentLoaded, type AboutContentState } from "./aboutContentStore"

/** Backend-driven About content, fetched once per session and cached as
 * last-known-good (see aboutContentStore.ts) -- the frontend is never a
 * second, independently-maintained source of truth for this copy. */
export function useAboutContent(): AboutContentState {
  const [state] = useSharedState(aboutContentStore)
  useEffect(() => {
    void ensureAboutContentLoaded()
  }, [])
  return state
}
