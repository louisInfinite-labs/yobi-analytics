import { describe, expect, it } from "vitest"
import {
  ALL_DELIVERY_SLOTS,
  DEFAULT_DELIVERY_SLOTS,
  DELIVERY_SLOTS_PER_DAY,
  MAX_DELIVERY_SLOTS,
  MIN_DELIVERY_SLOTS,
  addDeliverySlot,
  formatDeliverySlot,
  nextSuggestedDeliverySlot,
  normalizeDeliverySlots,
  removeDeliverySlot,
  replaceDeliverySlot,
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

describe("addDeliverySlot", () => {
  it("adds the next suggested time, keeping the result sorted", () => {
    expect(addDeliverySlot(["08:00", "18:00"])).toEqual({ ok: true, slots: ["08:00", "12:00", "18:00"] })
    expect(addDeliverySlot(["08:00", "12:00", "18:00"])).toEqual({ ok: true, slots: ["08:00", "12:00", "18:00", "21:00"] })
  })

  it("adds an explicit time", () => {
    expect(addDeliverySlot(["08:00", "18:00"], "12:30")).toEqual({ ok: true, slots: ["08:00", "12:30", "18:00"] })
  })

  it("refuses a 5th time", () => {
    expect(addDeliverySlot(["01:00", "02:00", "03:00", "04:00"])).toEqual({ ok: false, reason: "max" })
    expect(addDeliverySlot(["01:00", "02:00", "03:00", "04:00"], "05:00")).toEqual({ ok: false, reason: "max" })
  })

  it("refuses a duplicate and a label that is not a half-hour time", () => {
    expect(addDeliverySlot(["08:00", "18:00"], "08:00")).toEqual({ ok: false, reason: "duplicate" })
    expect(addDeliverySlot(["08:00"], "08:15")).toEqual({ ok: false, reason: "invalid" })
    expect(addDeliverySlot(["08:00"], "8:00 AM")).toEqual({ ok: false, reason: "invalid" })
  })

  it("does not mutate its input", () => {
    const current = ["08:00", "18:00"]
    addDeliverySlot(current)
    expect(current).toEqual(["08:00", "18:00"])
  })
})

describe("nextSuggestedDeliverySlot", () => {
  it("skips suggestions that are already chosen and is null at the maximum", () => {
    expect(nextSuggestedDeliverySlot(["08:00", "18:00"])).toBe("12:00")
    expect(nextSuggestedDeliverySlot(["12:00", "18:00"])).toBe("21:00")
    expect(nextSuggestedDeliverySlot(["01:00", "02:00", "03:00", "04:00"])).toBeNull()
  })
})

describe("removeDeliverySlot", () => {
  it("removes a chosen time", () => {
    expect(removeDeliverySlot(["08:00", "18:00"], "08:00")).toEqual({ ok: true, slots: ["18:00"] })
  })

  it("still allows removing from a full selection", () => {
    expect(removeDeliverySlot(["01:00", "02:00", "03:00", "04:00"], "04:00")).toEqual({ ok: true, slots: ["01:00", "02:00", "03:00"] })
  })

  it("refuses removing the only time, and a time that is not chosen", () => {
    expect(removeDeliverySlot(["08:00"], "08:00")).toEqual({ ok: false, reason: "min" })
    expect(removeDeliverySlot(["08:00", "18:00"], "12:00")).toEqual({ ok: false, reason: "missing" })
  })
})

describe("replaceDeliverySlot", () => {
  it("moves a chosen time, keeping the result sorted", () => {
    expect(replaceDeliverySlot(["08:00", "18:00"], "08:00", "19:30")).toEqual({ ok: true, slots: ["18:00", "19:30"] })
  })

  it("accepts choosing the same time again (a no-op) but refuses another row's time", () => {
    expect(replaceDeliverySlot(["08:00", "18:00"], "08:00", "08:00")).toEqual({ ok: true, slots: ["08:00", "18:00"] })
    expect(replaceDeliverySlot(["08:00", "18:00"], "08:00", "18:00")).toEqual({ ok: false, reason: "duplicate" })
  })

  it("refuses a value that is not a canonical half-hour time, and a row that does not exist", () => {
    expect(replaceDeliverySlot(["08:00", "18:00"], "08:00", "6:00 PM")).toEqual({ ok: false, reason: "invalid" })
    expect(replaceDeliverySlot(["08:00", "18:00"], "09:00", "10:00")).toEqual({ ok: false, reason: "missing" })
  })
})

describe("formatDeliverySlot (display only)", () => {
  it.each([
    ["08:00", "24h", "08:00"],
    ["18:00", "24h", "18:00"],
    ["00:30", "24h", "00:30"],
    ["08:00", "12h", "8:00 AM"],
    ["18:00", "12h", "6:00 PM"],
    ["00:00", "12h", "12:00 AM"],
    ["12:30", "12h", "12:30 PM"],
    ["23:30", "12h", "11:30 PM"],
  ] as const)("shows %s as %s in %s display", (slot, format, expected) => {
    expect(formatDeliverySlot(slot, format)).toBe(expected)
  })

  it("never changes the canonical value: every slot formats and still parses back to itself", () => {
    for (const slot of ALL_DELIVERY_SLOTS) {
      expect(formatDeliverySlot(slot, "24h")).toBe(slot)
      expect(ALL_DELIVERY_SLOTS).toContain(slot)
    }
  })
})
