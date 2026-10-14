import { useCallback } from "react"
import { useSharedState } from "../../../shared/state/sharedState"
import { saveNotificationPreference } from "../api/notificationPreferenceApi"
import { addDeliverySlot, removeDeliverySlot, replaceDeliverySlot, type DeliverySlotChangeResult } from "../model/deliverySlots"
import { getPushSubscriptionStatus } from "../push/pushNotifications"
import { deliverySlotsStore, getDeliverySlots } from "./deliverySlotsStore"
import {
  getEffectiveNewVideoCreatorIds,
  getEffectiveShortCreatorIds,
  NEW_VIDEO_SYNC_KEY,
  runSerialized,
} from "./useTopicNotificationPreferences"

export { getDeliverySlots }

/** Backend-first, like the per-creator new-video switches: when this browser has notifications enabled the full preference is written
 * with the PROPOSED times and the local selection only follows once the backend accepted it. Without a push subscription there is no
 * backend preference to update; the enable flow sends the stored times. Shares the new-video queue so it never interleaves with those
 * writes. `change` runs against the selection as it is when the queued write starts (so two quick edits compose), and resolves true
 * when the change was committed. */
function commitDeliverySlots(change: (current: readonly string[]) => DeliverySlotChangeResult): Promise<boolean> {
  return runSerialized(NEW_VIDEO_SYNC_KEY, async () => {
    const result = change(deliverySlotsStore.get())
    if (!result.ok) return

    let status: Awaited<ReturnType<typeof getPushSubscriptionStatus>> | null = null
    try {
      status = await getPushSubscriptionStatus()
    } catch {
      // Unreadable status: treated as "not enabled", same as the creator-switch sync.
    }
    if (status === "subscribed") {
      // The disabled-by-user check lives inside saveNotificationPreference, right before the PUT.
      await saveNotificationPreference(true, getEffectiveNewVideoCreatorIds(), getEffectiveShortCreatorIds(), result.slots)
    }
    deliverySlotsStore.set(result.slots)
  })
}

export function useDeliverySlots() {
  const [slots] = useSharedState(deliverySlotsStore)
  /** Adds one more time (the next suggested one); a no-op at the maximum. */
  const addSlot = useCallback(() => commitDeliverySlots((current) => addDeliverySlot(current)), [])
  /** Removes a time; a no-op when it is the only one left. */
  const removeSlot = useCallback((slot: string) => commitDeliverySlots((current) => removeDeliverySlot(current, slot)), [])
  /** Moves one chosen time to another; a no-op when the new time is already chosen. */
  const changeSlot = useCallback((from: string, to: string) => commitDeliverySlots((current) => replaceDeliverySlot(current, from, to)), [])
  return { slots, addSlot, removeSlot, changeSlot }
}
