import { describe, expect, it } from "vitest"
import {
  ALL_DELIVERY_SLOTS,
  DEFAULT_DELIVERY_SLOTS,
  DELIVERY_SLOTS_PER_DAY,
  MAX_DELIVERY_SLOTS,
  MIN_DELIVERY_SLOTS,
  normalizeDeliverySlots,
  toggleDeliverySlot,
} from "./deliverySlots"

describe("delivery slot constants", () => {
  it("are the 48 half-hour labels of a day, 1 to 4 selectable, default 08:00 and 18:00", () => {
    expect(ALL_DELIVERY_SLOTS).toHaveLength(DELIVERY_SLOTS_PER_DAY)
    expect(ALL_DELIVERY_SLOTS[0]).toBe("00:00")
    expect(ALL_DELIVERY_SLOTS[1]).toBe("00:30")
    expect(ALL_DELIVERY_SLOTS[47]).toBe("23:30")
    expect(new Set(ALL_DELIVERY_SLOTS).size).toBe(48)
    expect(ALL_DELIVERY_SLOTS.every((slot) => /^([01]\d|2[0-3]):(00|30)$/.test(slot))).toBe(true)
    expect(MAX_DELIVERY_SLOTS).toBe(4)
    expect(MIN_DELIVERY_SLOTS).toBe(1)
    expect(DEFAULT_DELIVERY_SLOTS).toEqual(["08:00", "18:00"])
  })
})

describe("normalizeDeliverySlots", () => {
  it("keeps a valid selection as is", () => {
    expect(normalizeDeliverySlots(["07:30", "21:00"])).toEqual(["07:30", "21:00"])
  })

  it("drops anything that is not a half-hour label", () => {
    expect(normalizeDeliverySlots(["08:15", "24:00", "8:00", "08:00:00", 800, null, "", "12:30"])).toEqual(["12:30"])
  })

  it("dedupes and sorts ascending", () => {
    expect(normalizeDeliverySlots(["18:00", "08:00", "18:00", "00:30"])).toEqual(["00:30", "08:00", "18:00"])
  })

  it("caps at 4, keeping the earliest", () => {
    expect(normalizeDeliverySlots(["23:30", "01:00", "05:00", "03:00", "02:00", "04:00"])).toEqual(["01:00", "02:00", "03:00", "04:00"])
  })

  it.each([[[]], [["08:15", "nope"]], [null], [undefined], ["08:00"], [{ 0: "08:00" }], [42]])("falls back to the default for %j", (raw) => {
    expect(normalizeDeliverySlots(raw)).toEqual(["08:00", "18:00"])
  })

  it("returns a fresh array, never the shared default", () => {
    const result = normalizeDeliverySlots(null)
    result.push("00:00")
    expect(DEFAULT_DELIVERY_SLOTS).toEqual(["08:00", "18:00"])
  })
})

describe("toggleDeliverySlot", () => {
  it("adds an unselected slot, keeping the result sorted", () => {
    expect(toggleDeliverySlot(["08:00", "18:00"], "12:30")).toEqual({ ok: true, slots: ["08:00", "12:30", "18:00"] })
  })

  it("removes a selected slot", () => {
    expect(toggleDeliverySlot(["08:00", "18:00"], "08:00")).toEqual({ ok: true, slots: ["18:00"] })
  })

  it("refuses a 5th slot", () => {
    expect(toggleDeliverySlot(["01:00", "02:00", "03:00", "04:00"], "05:00")).toEqual({ ok: false, reason: "max" })
  })

  it("still allows removing from a full selection", () => {
    expect(toggleDeliverySlot(["01:00", "02:00", "03:00", "04:00"], "04:00")).toEqual({ ok: true, slots: ["01:00", "02:00", "03:00"] })
  })

  it("refuses removing the only slot", () => {
    expect(toggleDeliverySlot(["08:00"], "08:00")).toEqual({ ok: false, reason: "min" })
  })

  it("refuses a label that is not a slot", () => {
    expect(toggleDeliverySlot(["08:00"], "08:15")).toEqual({ ok: false, reason: "invalid" })
  })

  it("does not mutate its input", () => {
    const current = ["08:00", "18:00"]
    toggleDeliverySlot(current, "09:00")
    expect(current).toEqual(["08:00", "18:00"])
  })
})
