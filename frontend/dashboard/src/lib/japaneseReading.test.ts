import { describe, expect, it } from "vitest"
import { normalizeJapaneseReadingForSort } from "./japaneseReading"

describe("normalizeJapaneseReadingForSort", () => {
  it("converts a pure Katakana reading to its Hiragana equivalent", () => {
    expect(normalizeJapaneseReadingForSort("アイラ")).toBe("あいら")
    expect(normalizeJapaneseReadingForSort("ウルフ")).toBe("うるふ")
  })

  it("leaves a pure Hiragana reading unchanged", () => {
    expect(normalizeJapaneseReadingForSort("あいら")).toBe("あいら")
    expect(normalizeJapaneseReadingForSort("うるふ")).toBe("うるふ")
  })

  it("produces the same normalized key for the Hiragana and Katakana spelling of the same reading", () => {
    expect(normalizeJapaneseReadingForSort("アイラ")).toBe(normalizeJapaneseReadingForSort("あいら"))
    expect(normalizeJapaneseReadingForSort("ウルフ")).toBe(normalizeJapaneseReadingForSort("うるふ"))
  })

  it("normalizes a single reading that mixes Hiragana and Katakana", () => {
    expect(normalizeJapaneseReadingForSort("いちのせウルハ")).toBe("いちのせうるは")
  })

  it("leaves non-kana characters (e.g. the chōonpu long vowel mark) unchanged", () => {
    expect(normalizeJapaneseReadingForSort("カード")).toBe("かーど")
  })
})
