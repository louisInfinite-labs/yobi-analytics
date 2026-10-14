/** Query normalization + activation-threshold rules for Video Search (product spec section 13/14).
 *
 * Normalization is deliberately conservative: NFKC (folds full-width/half-width variants and other
 * compatibility forms), trim, collapse internal whitespace, and lowercase (Latin only -- NFKC/
 * toLocaleLowerCase never rewrites CJK into a different character). Nothing here attempts fuzzy
 * correction or aggressive punctuation stripping.
 *
 * Activation thresholds (what makes Search go from "typing" to "actually filtering"):
 *   - any Han (CJK ideograph) character present -> active immediately (one character is enough)
 *   - any Japanese kana (hiragana/katakana) character present -> active immediately, same reasoning
 *   - otherwise, Latin letters + digits only: letters+digits mixed needs length >= 2, letters-only
 *     needs length >= 3; a query with neither letters nor digits (e.g. only punctuation) never activates
 * This exact set of examples is required by spec and is asserted in queryNormalization.test.ts:
 *   a/ab -> inactive, abc/bir/birth -> active, 3D/2D/V2/SF6 -> active, 魔 -> active, モンハン -> active. */

const HAN_PATTERN = /\p{Script=Han}/u
const KANA_PATTERN = /[\p{Script=Hiragana}\p{Script=Katakana}]/u
const LATIN_LETTER_PATTERN = /[a-z]/i
const DIGIT_PATTERN = /[0-9]/

export interface NormalizedQuery {
  /** The query after NFKC + trim + whitespace-collapse + Latin lowercasing. Empty string for a blank/whitespace-only input. */
  normalized: string
  /** Codepoint length of `normalized` (Array.from, not .length, so no surrogate-pair miscounts). */
  length: number
}

/** Collapses internal runs of whitespace to one space; does not touch CJK characters. */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ")
}

export function normalizeQuery(raw: string): NormalizedQuery {
  const normalized = collapseWhitespace(raw.normalize("NFKC").trim()).toLocaleLowerCase()
  return { normalized, length: Array.from(normalized).length }
}

/** Whether a normalized query meets the product's activation threshold (section 13). Call this on the
 * `normalized` result of normalizeQuery -- it assumes NFKC/trim/lowercasing already happened. */
export function isQueryActive(normalized: string): boolean {
  if (normalized.length === 0) return false
  if (HAN_PATTERN.test(normalized)) return true
  if (KANA_PATTERN.test(normalized)) return true

  const hasLatin = LATIN_LETTER_PATTERN.test(normalized)
  const hasDigit = DIGIT_PATTERN.test(normalized)
  if (!hasLatin && !hasDigit) return false

  const length = Array.from(normalized).length
  // Latin+digit mix (3D, V2, SF6, ...): length >= 2. Latin-only or digit-only: length >= 3.
  const threshold = hasLatin && hasDigit ? 2 : 3
  return length >= threshold
}
