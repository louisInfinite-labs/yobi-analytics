import { useCallback } from "react"
import { useSharedState } from "../../../shared/state/sharedState"
import { saveNotificationPreference } from "../api/notificationPreferenceApi"
import { toggleDeliverySlot } from "../model/deliverySlots"
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
 * with the PROPOSED slots and the local selection only follows once the backend accepted it. Without a push subscription there is no
 * backend preference to update; the enable flow sends the stored slots. Shares the new-video queue so it never interleaves with those
 * writes. Resolves true when the change was committed. */
function changeDeliverySlots(slot: string): Promise<boolean> {
  return runSerialized(NEW_VIDEO_SYNC_KEY, async () => {
    const result = toggleDeliverySlot(deliverySlotsStore.get(), slot)
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
  const toggleSlot = useCallback((slot: string) => changeDeliverySlots(slot), [])
  return { slots, toggleSlot }
}
