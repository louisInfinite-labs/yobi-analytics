export const DELIVERY_SLOTS_PER_DAY = 48
export const MAX_DELIVERY_SLOTS = 4
export const MIN_DELIVERY_SLOTS = 1

/** "00:00", "00:30", ... "23:30": the fixed half-hour slots of the user's own local day. */
export const ALL_DELIVERY_SLOTS: readonly string[] = Array.from({ length: DELIVERY_SLOTS_PER_DAY }, (_, index) => {
  const hour = String(Math.floor(index / 2)).padStart(2, "0")
  return `${hour}:${index % 2 === 0 ? "00" : "30"}`
})

export const DEFAULT_DELIVERY_SLOTS: readonly string[] = ["08:00", "18:00"]

const SLOT_SET: ReadonlySet<string> = new Set(ALL_DELIVERY_SLOTS)

export function isDeliverySlot(value: unknown): value is string {
  return typeof value === "string" && SLOT_SET.has(value)
}

/** Always a valid selection: invalid labels and duplicates dropped, sorted, capped at the earliest MAX, default when nothing valid remains. */
export function normalizeDeliverySlots(raw: unknown): string[] {
  const valid = Array.isArray(raw) ? [...new Set(raw.filter(isDeliverySlot))].sort() : []
  if (valid.length === 0) return [...DEFAULT_DELIVERY_SLOTS]
  return valid.slice(0, MAX_DELIVERY_SLOTS)
}

export type ToggleDeliverySlotResult = { ok: true; slots: string[] } | { ok: false; reason: "max" | "min" | "invalid" }

/** The selection after toggling `slot`, or why that is not allowed (a 5th slot, removing the only slot, a label that is not a slot). */
export function toggleDeliverySlot(current: readonly string[], slot: string): ToggleDeliverySlotResult {
  if (!isDeliverySlot(slot)) return { ok: false, reason: "invalid" }
  const selected = normalizeDeliverySlots(current)
  if (selected.includes(slot)) {
    if (selected.length <= MIN_DELIVERY_SLOTS) return { ok: false, reason: "min" }
    return { ok: true, slots: selected.filter((existing) => existing !== slot) }
  }
  if (selected.length >= MAX_DELIVERY_SLOTS) return { ok: false, reason: "max" }
  return { ok: true, slots: [...selected, slot].sort() }
}
