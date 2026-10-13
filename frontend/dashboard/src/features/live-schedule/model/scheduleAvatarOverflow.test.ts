import { describe, expect, it } from "vitest"
import { AVATAR_GAP_PX, DEFAULT_AVATAR_SIZE_PX, MORE_CHIP_MIN_WIDTH_PX, moreChipWidth, visibleAvatarCount } from "./scheduleAvatarOverflow"

const A = DEFAULT_AVATAR_SIZE_PX // 36
const STEP = A + AVATAR_GAP_PX // 40

/** The width of `n` avatars with `chip` after them (what the slot has to be able to hold). */
const widthWith = (n: number, chipWidth: number) => n * STEP + chipWidth

describe("without a measured width: only the fixed multi-day rule (more than 4 streams -> 3 + +N)", () => {
  it.each([
    [1, 1],
    [4, 4],
    [5, 3],
    [12, 3],
  ])("multi-day, %i streams -> %i avatars", (total, expected) => {
    expect(visibleAvatarCount(total, { availableWidth: null, boundedByFixedRule: true })).toBe(expected)
  })

  it.each([null, 0, -5, Number.NaN])("a width of %s means 'unknown', never 'nothing fits'", (width) => {
    expect(visibleAvatarCount(9, { availableWidth: width as number | null, boundedByFixedRule: true })).toBe(3)
  })

  it("the single-day layout, with no width yet, shows every avatar (nothing to collapse by)", () => {
    expect(visibleAvatarCount(9, { availableWidth: null, boundedByFixedRule: false })).toBe(9)
  })
})

describe("multi-day grid: the fixed rule stays an upper bound, the width can only reduce it", () => {
  it("wide columns look exactly as before (4 -> all, 5+ -> 3 and +N)", () => {
    for (const width of [160, 230, 400]) {
      expect(visibleAvatarCount(4, { availableWidth: width, boundedByFixedRule: true })).toBe(4)
      expect(visibleAvatarCount(5, { availableWidth: width, boundedByFixedRule: true })).toBe(3)
      expect(visibleAvatarCount(12, { availableWidth: width, boundedByFixedRule: true })).toBe(3)
    }
  })

  it("a column too narrow for the fixed count shows only what fits beside the chip (never overflows its column)", () => {
    // 117px (a 1024px-wide screen): 4 streams do not all fit -> 2 + chip; 12 streams hide 10 -> a 2-digit chip, so only 1 fits.
    expect(visibleAvatarCount(4, { availableWidth: 117, boundedByFixedRule: true })).toBe(2)
    expect(visibleAvatarCount(12, { availableWidth: 117, boundedByFixedRule: true })).toBe(1)
    // 80px (a tablet): one avatar and the chip.
    expect(visibleAvatarCount(4, { availableWidth: 80, boundedByFixedRule: true })).toBe(1)
  })

  it("never returns a count that, with its chip, is wider than the column", () => {
    for (let width = 40; width <= 400; width += 7) {
      for (let total = 1; total <= 14; total++) {
        const visible = visibleAvatarCount(total, { availableWidth: width, boundedByFixedRule: true })
        const hidden = total - visible
        const used = hidden === 0 ? total * A + (total - 1) * AVATAR_GAP_PX : widthWith(visible, moreChipWidth(hidden))
        if (visible > 0 || hidden === 0) expect(used, `width ${width}, ${total} streams`).toBeLessThanOrEqual(width)
      }
    }
  })
})

describe("single-day phone layout: as many avatars as actually fit, then +N", () => {
  it("shows every avatar when they all fit (no +N at all)", () => {
    // 7 avatars = 7*36 + 6*4 = 276
    expect(visibleAvatarCount(7, { availableWidth: 312, boundedByFixedRule: false })).toBe(7)
    expect(visibleAvatarCount(7, { availableWidth: 276, boundedByFixedRule: false })).toBe(7)
  })

  it("reserves room for the +N chip when they do not all fit", () => {
    expect(visibleAvatarCount(7, { availableWidth: 275, boundedByFixedRule: false })).toBe(6) // 6 avatars + chip(1 hidden) = 240 + 35
    expect(visibleAvatarCount(9, { availableWidth: 312, boundedByFixedRule: false })).toBe(6) // 240 + 35 = 275; a 7th would need 315
    expect(visibleAvatarCount(12, { availableWidth: 312, boundedByFixedRule: false })).toBe(6) // hides 6 -> 1-digit chip
  })

  it("grows with the width: a wider phone fits more avatars", () => {
    const counts = [312, 315, 352, 362].map((width) => visibleAvatarCount(12, { availableWidth: width, boundedByFixedRule: false }))
    expect(counts).toEqual([6, 7, 7, 8]) // 7 avatars + a 1-digit chip is exactly 315px
  })

  it("is not capped by the multi-day rule (the whole point of the phone layout)", () => {
    expect(visibleAvatarCount(9, { availableWidth: 312, boundedByFixedRule: false })).toBeGreaterThan(visibleAvatarCount(9, { availableWidth: 312, boundedByFixedRule: true }))
  })

  it("the hidden count is exact: visible + hidden always equals the number of streams", () => {
    for (const total of [1, 2, 5, 9, 14]) {
      const visible = visibleAvatarCount(total, { availableWidth: 200, boundedByFixedRule: false })
      expect(visible + (total - visible)).toBe(total)
      expect(visible).toBeLessThanOrEqual(total)
    }
  })

  it("a column that cannot even hold the chip beside one avatar shows only the +N (everything behind it)", () => {
    expect(visibleAvatarCount(3, { availableWidth: 50, boundedByFixedRule: false })).toBe(0)
  })

  it("no streams, nothing to draw", () => {
    expect(visibleAvatarCount(0, { availableWidth: 300, boundedByFixedRule: false })).toBe(0)
  })
})

describe("the +N chip's width follows its label", () => {
  it("is the CSS minimum for one digit and grows for 2 and 3 digits", () => {
    expect(moreChipWidth(1)).toBe(MORE_CHIP_MIN_WIDTH_PX)
    expect(moreChipWidth(9)).toBe(MORE_CHIP_MIN_WIDTH_PX)
    expect(moreChipWidth(10)).toBeGreaterThan(moreChipWidth(9))
    expect(moreChipWidth(100)).toBeGreaterThan(moreChipWidth(99))
  })
})
