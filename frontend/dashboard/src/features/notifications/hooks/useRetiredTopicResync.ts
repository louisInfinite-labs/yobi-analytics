import { useEffect } from "react"
import { resyncAfterRetiredMigration } from "./useTopicNotificationPreferences"

/** Mounted once at the app root: when the load-time migration retired a notification card that had enabled new videos, re-sends the
 * preference so the backend copy is clean even if the user never opens Settings (see resyncAfterRetiredMigration). */
export function useRetiredTopicResync(): void {
  useEffect(() => {
    void resyncAfterRetiredMigration()
  }, [])
}
