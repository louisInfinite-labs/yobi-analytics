import { formatClockTime, type TimeFormat } from "../../../shared/i18n/model/timeFormat"

export const DELIVERY_SLOTS_PER_DAY = 48
export const MAX_DELIVERY_SLOTS = 4
export const MIN_DELIVERY_SLOTS = 1

/** "00:00", "00:30", ... "23:30": the fixed half-hour slots of the user's OWN local day. These canonical 24-hour strings are what is
 * stored and sent to the backend; how a slot is shown (24h or 12h) never leaves the display layer (see formatDeliverySlot). */
export const ALL_DELIVERY_SLOTS: readonly string[] = Array.from({ length: DELIVERY_SLOTS_PER_DAY }, (_, index) => {
  const hour = String(Math.floor(index / 2)).padStart(2, "0")
  return `${hour}:${index % 2 === 0 ? "00" : "30"}`
})

export const DEFAULT_DELIVERY_SLOTS: readonly string[] = ["08:00", "18:00"]

/** The times a freshly added row starts on, in preference order (the first one not already chosen): spread across the day. */
const SUGGESTED_ADDITIONS: readonly string[] = ["12:00", "21:00", "06:00", "15:00", "09:00", "20:00", "07:00", "13:00"]

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

/** A canonical slot ("18:00") as the user sees it: "18:00" in 24-hour display, "6:00 PM" in 12-hour display. Display only. */
export function formatDeliverySlot(slot: string, timeFormat: TimeFormat): string {
  const [hours, minutes] = slot.split(":").map(Number)
  return formatClockTime(new Date(2000, 0, 1, hours, minutes), timeFormat)
}

export type DeliverySlotChangeResult = { ok: true; slots: string[] } | { ok: false; reason: "max" | "min" | "invalid" | "duplicate" | "missing" }

/** The first suggested time that is not chosen yet (any free half hour when every suggestion is taken), or null at the maximum. */
export function nextSuggestedDeliverySlot(current: readonly string[]): string | null {
  const selected = normalizeDeliverySlots(current)
  if (selected.length >= MAX_DELIVERY_SLOTS) return null
  return SUGGESTED_ADDITIONS.find((slot) => !selected.includes(slot)) ?? ALL_DELIVERY_SLOTS.find((slot) => !selected.includes(slot)) ?? null
}

/** The selection with one more time (`slot`, or the next suggested one), or why that is not allowed (a 5th time, a time already chosen). */
export function addDeliverySlot(current: readonly string[], slot?: string): DeliverySlotChangeResult {
  const selected = normalizeDeliverySlots(current)
  if (selected.length >= MAX_DELIVERY_SLOTS) return { ok: false, reason: "max" }
  const added = slot ?? nextSuggestedDeliverySlot(selected)
  if (added === null || !isDeliverySlot(added)) return { ok: false, reason: "invalid" }
  if (selected.includes(added)) return { ok: false, reason: "duplicate" }
  return { ok: true, slots: [...selected, added].sort() }
}

/** The selection without `slot`, or why that is not allowed (it is not chosen, or it is the only time left). */
export function removeDeliverySlot(current: readonly string[], slot: string): DeliverySlotChangeResult {
  const selected = normalizeDeliverySlots(current)
  if (!selected.includes(slot)) return { ok: false, reason: "missing" }
  if (selected.length <= MIN_DELIVERY_SLOTS) return { ok: false, reason: "min" }
  return { ok: true, slots: selected.filter((existing) => existing !== slot) }
}

/** The selection with `from` changed to `to`: refused when `to` is not a half-hour time, `from` is not chosen, or `to` is already chosen. */
export function replaceDeliverySlot(current: readonly string[], from: string, to: string): DeliverySlotChangeResult {
  const selected = normalizeDeliverySlots(current)
  if (!isDeliverySlot(to)) return { ok: false, reason: "invalid" }
  if (!selected.includes(from)) return { ok: false, reason: "missing" }
  if (to !== from && selected.includes(to)) return { ok: false, reason: "duplicate" }
  return { ok: true, slots: selected.map((slot) => (slot === from ? to : slot)).sort() }
}
