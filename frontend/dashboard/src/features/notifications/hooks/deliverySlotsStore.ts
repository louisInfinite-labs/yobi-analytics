import { createSharedState } from "../../../shared/state/sharedState"
import { normalizeDeliverySlots } from "../model/deliverySlots"

const STORAGE_KEY = "yobi.notificationDeliverySlots"

function readSlots(): string[] {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return normalizeDeliverySlots(stored === null ? null : JSON.parse(stored))
  } catch {
    return normalizeDeliverySlots(null)
  }
}

// Holds the LAST CONFIRMED selection: a change reaches it only after the backend accepted it (see useDeliverySlots).
export const deliverySlotsStore = createSharedState<string[]>(STORAGE_KEY, readSlots, (slots) => JSON.stringify(slots))

/** The current delivery slots, for writers outside React. Kept apart from useDeliverySlots so the preference API can read it without an import cycle. */
export function getDeliverySlots(): string[] {
  return deliverySlotsStore.get()
}
