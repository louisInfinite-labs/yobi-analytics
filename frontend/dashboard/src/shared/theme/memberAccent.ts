// Per-creator accent colors for small-area use (avatars, badges, chart
// series, currentOshi theme binding). A verified backend themeColor (Creator
// Master's own field, see creator_master.py) is always preferred when the
// caller has one; the curated muted palette below is the fallback for every
// creator without a verified color yet, hashed deterministically so it's
// still stable across reloads and scales to the full ~120-creator roster
// without per-creator authoring.

export interface MemberAccent {
  primary: string
  soft: string
  textAccent: string
}

const PALETTE: MemberAccent[] = [
  { primary: "#c77fb0", soft: "#f3dcec", textAccent: "#8a4a76" }, // soft pink
  { primary: "#5a8fd6", soft: "#dbe7f8", textAccent: "#2c4f85" }, // soft blue
  { primary: "#5fae8f", soft: "#dcf0e6", textAccent: "#2f6b52" }, // soft teal
  { primary: "#d9a441", soft: "#f7ecd4", textAccent: "#8a6416" }, // soft amber
  { primary: "#9b7fd6", soft: "#e9e0f7", textAccent: "#5b3f92" }, // soft violet
  { primary: "#e0708a", soft: "#f9dde3", textAccent: "#96334c" }, // soft rose
  { primary: "#3f8fae", soft: "#d8ecf4", textAccent: "#215a70" }, // soft cyan
  { primary: "#d97b3f", soft: "#f7ded0", textAccent: "#8a4a1f" }, // soft orange
]

const THEME_COLOR_RE = /^#[0-9a-fA-F]{6}$/

/** Simple deterministic string hash (djb2-style), used to pick a stable palette index. */
function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
}

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, "0")).join("")}`.toUpperCase()
}

/** themeColor mixed toward `target` by `ratio` -- used for both the light
 * "soft" tint (mixed toward white) and the "textAccent" shade (mixed toward
 * whichever of black/white contrasts against themeColor itself). */
function mixToward(hex: string, target: [number, number, number], ratio: number): string {
  const [r, g, b] = hexToRgb(hex)
  const [tr, tg, tb] = target
  return rgbToHex(r + (tr - r) * ratio, g + (tg - g) * ratio, b + (tb - b) * ratio)
}

/** ITU-R BT.601 perceived brightness (0-255) -- only used to pick a contrast
 * direction for textAccent, not a WCAG-grade luminance calculation. */
function perceivedBrightness(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return (r * 299 + g * 587 + b * 114) / 1000
}

/** A verified backend color (any hue/lightness, including #FFFFFF/#000000 --
 * see Creator Master's own themeColor field) still needs a soft tint and a
 * textAccent that contrasts against it; both are derived rather than stored,
 * since only one canonical color is ever persisted per creator. `primary` is
 * normalized to the same uppercase canonical form `soft`/`textAccent`
 * already get from rgbToHex, so a lowercase-but-valid input (e.g. from a
 * mock/test/future API source) can never produce a MemberAccent whose three
 * hex values disagree on case. */
function accentFromThemeColor(themeColor: string): MemberAccent {
  const normalizedThemeColor = themeColor.toUpperCase()
  const textTarget: [number, number, number] = perceivedBrightness(normalizedThemeColor) > 140 ? [0, 0, 0] : [255, 255, 255]
  return {
    primary: normalizedThemeColor,
    soft: mixToward(normalizedThemeColor, [255, 255, 255], 0.82),
    textAccent: mixToward(normalizedThemeColor, textTarget, 0.62),
  }
}

/** This creator's accent color: their verified backend themeColor when one
 * exists, otherwise the deterministic hashed palette fallback. `channelId`
 * alone (not a full creator record) is deliberate -- every existing call
 * site already has just an id in hand in several places, and hashing it is
 * itself the fallback's whole mechanism. */
export function getMemberAccent(channelId: string, themeColor?: string | null): MemberAccent {
  if (themeColor && THEME_COLOR_RE.test(themeColor)) return accentFromThemeColor(themeColor)
  const index = hashString(channelId) % PALETTE.length
  return PALETTE[index]
}
