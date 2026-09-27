import { describe, expect, it } from "vitest"
import { creatorThemeStyle } from "./creatorThemeStyle"
import { getMemberAccent } from "./memberAccent"

function creatorMain(style: ReturnType<typeof creatorThemeStyle>): string {
  return (style as Record<string, string>)["--creator-main"]
}

describe("creatorThemeStyle", () => {
  it("uses the given creator's valid themeColor for --creator-main/--creator-sub", () => {
    const style = creatorThemeStyle("ch_aizawa_ema", "#B4F1F9")
    const accent = getMemberAccent("ch_aizawa_ema", "#B4F1F9")
    expect(creatorMain(style)).toBe(accent.primary)
    expect((style as Record<string, string>)["--creator-sub"]).toBe(accent.textAccent)
  })

  it("falls back to the deterministic hashed palette when themeColor is missing", () => {
    const style = creatorThemeStyle("ch_aizawa_ema")
    const fallback = getMemberAccent("ch_aizawa_ema")
    expect(creatorMain(style)).toBe(fallback.primary)
  })

  it("falls back to the deterministic hashed palette when themeColor is invalid", () => {
    const style = creatorThemeStyle("ch_aizawa_ema", "not-a-color")
    const fallback = getMemberAccent("ch_aizawa_ema")
    expect(creatorMain(style)).toBe(fallback.primary)
  })

  it("trusts the caller's own themeColor over whatever mockCreators has on file for that channelId, proving it does no lookup of its own", () => {
    // ch_aizawa_ema's own mockCreators.ts record carries "#B4F1F9" -- if this
    // helper still did its own internal creator lookup (the exact
    // duplicate-database pattern this task removes), that value would win
    // regardless of what's passed in below.
    const style = creatorThemeStyle("ch_aizawa_ema", "#123456")
    const accent = getMemberAccent("ch_aizawa_ema", "#123456")
    expect(creatorMain(style)).toBe(accent.primary)
    expect(creatorMain(style)).not.toBe("#B4F1F9")
  })
})
