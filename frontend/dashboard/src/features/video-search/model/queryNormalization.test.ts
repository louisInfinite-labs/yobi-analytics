import { describe, expect, it } from "vitest"
import { isQueryActive, normalizeQuery } from "./queryNormalization"

describe("normalizeQuery", () => {
  it("trims, collapses internal whitespace, and lowercases Latin text consistently", () => {
    expect(normalizeQuery("  Monster   Hunter  ").normalized).toBe("monster hunter")
    expect(normalizeQuery("monster hunter").normalized).toBe("monster hunter")
    expect(normalizeQuery("MONSTER HUNTER").normalized).toBe("monster hunter")
  })

  it("applies Unicode NFKC, folding full-width Latin/digits to their half-width form", () => {
    // Full-width "ＳＦ６" (U+FF33 U+FF26 U+FF16) NFKC-normalizes to half-width "sf6".
    expect(normalizeQuery("ＳＦ６").normalized).toBe("sf6")
  })

  it("never rewrites CJK text into a different form", () => {
    expect(normalizeQuery("魔物獵人").normalized).toBe("魔物獵人")
    expect(normalizeQuery("モンハン").normalized).toBe("モンハン")
  })

  it("counts codepoints, not UTF-16 length, for the activation threshold", () => {
    expect(normalizeQuery("魔").length).toBe(1)
  })
})

describe("isQueryActive -- the required examples from the product spec", () => {
  const cases: [string, boolean][] = [
    ["a", false],
    ["ab", false],
    ["abc", true],
    ["bir", true],
    ["birth", true],
    ["3D", true],
    ["2D", true],
    ["V2", true],
    ["SF6", true],
    ["魔", true],
    ["モンハン", true],
  ]

  it.each(cases)("%s -> active=%s", (raw, expected) => {
    expect(isQueryActive(normalizeQuery(raw).normalized)).toBe(expected)
  })

  it("treats one Han character as sufficient even mixed with other scripts", () => {
    expect(isQueryActive(normalizeQuery("誕").normalized)).toBe(true)
  })

  it("is inactive for an empty or whitespace-only query", () => {
    expect(isQueryActive(normalizeQuery("").normalized)).toBe(false)
    expect(isQueryActive(normalizeQuery("   ").normalized)).toBe(false)
  })

  it("is inactive for punctuation-only input with no letters, digits, Han, or kana", () => {
    expect(isQueryActive(normalizeQuery("...").normalized)).toBe(false)
  })
})
