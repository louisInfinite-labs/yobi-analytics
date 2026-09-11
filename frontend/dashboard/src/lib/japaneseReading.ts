const KATAKANA_START = 0x30a1 // ァ
const KATAKANA_END = 0x30f6 // ヶ (the contiguous Katakana block that has a 1:1 Hiragana counterpart)
const HIRAGANA_OFFSET = 0x60 // Katakana code point minus this = its Hiragana equivalent

/** Converts a Japanese reading to a normalized sort key: Katakana characters
 * become their Hiragana equivalent so Hiragana and Katakana readings
 * interleave in ONE gojuon order instead of sorting as two separate blocks
 * (this task's "Hiragana/Katakana combined phonetic sorting" requirement).
 * This exists ONLY for sorting — callers must keep using the original
 * `creator.kana` for anything displayed. Characters outside the standard
 * Katakana block (e.g. the chōonpu "ー", or any non-kana character) pass
 * through unchanged; no example in this task's spec requires them to
 * collate specially, so inventing that behavior here would be guessing. */
export function normalizeJapaneseReadingForSort(reading: string): string {
  let result = ""
  for (const char of reading) {
    const code = char.codePointAt(0)!
    result += code >= KATAKANA_START && code <= KATAKANA_END ? String.fromCodePoint(code - HIRAGANA_OFFSET) : char
  }
  return result
}
