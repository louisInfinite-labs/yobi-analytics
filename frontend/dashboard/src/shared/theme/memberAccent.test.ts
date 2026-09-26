import { describe, expect, it } from "vitest"
import { getMemberAccent } from "./memberAccent"

const HEX = /^#[0-9A-F]{6}$/

describe("getMemberAccent", () => {
  it("uses the verified backend themeColor as primary when one is given", () => {
    const accent = getMemberAccent("ch_aizawa_ema", "#B4F1F9")
    expect(accent.primary).toBe("#B4F1F9")
  })

  it("falls back to the deterministic hashed palette when themeColor is absent", () => {
    const withColor = getMemberAccent("ch_aizawa_ema", "#B4F1F9")
    const withoutColor = getMemberAccent("ch_aizawa_ema")
    expect(withoutColor.primary).not.toBe(withColor.primary)
    expect(withoutColor.primary).toBe(getMemberAccent("ch_aizawa_ema", null).primary)
    expect(withoutColor.primary).toBe(getMemberAccent("ch_aizawa_ema", undefined).primary)
  })

  it("falls back to the hashed palette when themeColor is malformed", () => {
    const fallback = getMemberAccent("ch_aizawa_ema")
    expect(getMemberAccent("ch_aizawa_ema", "B4F1F9").primary).toBe(fallback.primary)
    expect(getMemberAccent("ch_aizawa_ema", "#FFF").primary).toBe(fallback.primary)
    expect(getMemberAccent("ch_aizawa_ema", "").primary).toBe(fallback.primary)
  })

  it("hashes the same channelId to the same fallback color every call", () => {
    expect(getMemberAccent("ch_shirakami_fubuki").primary).toBe(getMemberAccent("ch_shirakami_fubuki").primary)
  })

  it("derives a soft tint and a textAccent shade for a verified themeColor, both valid hex", () => {
    const accent = getMemberAccent("ch_aizawa_ema", "#B4F1F9")
    expect(accent.soft).toMatch(HEX)
    expect(accent.textAccent).toMatch(HEX)
  })

  it("handles the extreme #FFFFFF verified color without collapsing textAccent into white-on-white", () => {
    const accent = getMemberAccent("ch_sorasumi_sena", "#FFFFFF")
    expect(accent.primary).toBe("#FFFFFF")
    expect(accent.textAccent).not.toBe("#FFFFFF")
  })

  it("handles the extreme #000000 verified color without collapsing textAccent into black-on-black", () => {
    const accent = getMemberAccent("ch_arya_kuroha", "#000000")
    expect(accent.primary).toBe("#000000")
    expect(accent.textAccent).not.toBe("#000000")
  })

  it("normalizes a lowercase themeColor to uppercase output", () => {
    const accent = getMemberAccent("ch_aizawa_ema", "#b4f1f9")
    expect(accent.primary).toBe("#B4F1F9")
    expect(accent.soft).toMatch(HEX)
    expect(accent.textAccent).toMatch(HEX)
  })

  it("produces the identical accent object for a lowercase and its uppercase equivalent", () => {
    const fromLowercase = getMemberAccent("ch_aizawa_ema", "#b4f1f9")
    const fromUppercase = getMemberAccent("ch_aizawa_ema", "#B4F1F9")
    expect(fromLowercase).toEqual(fromUppercase)
  })

  it("picks the higher-contrast textAccent for #EA5506 (regression: the fixed 'mix toward white' direction only reached ~2.2:1 against this primary)", () => {
    const accent = getMemberAccent("ch_regression_ea5506", "#EA5506")
    expect(contrastRatio(accent.primary, accent.textAccent)).toBeGreaterThanOrEqual(3)
  })
})

/** Local copy of the same WCAG contrast-ratio formula memberAccent.ts uses
 * internally, so this test verifies the actual resulting textAccent contrast
 * rather than an implementation-internal "target" choice. */
function contrastRatio(hexA: string, hexB: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [lighter, darker] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}
