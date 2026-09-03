// Deterministic, restrained per-creator accent colors for small-area use
// (avatars, badges, chart series) — derived from a curated muted palette
// rather than one hand-authored theme per individual member, so it scales
// to the full ~70-creator roster without per-creator authoring.

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

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
}

export function getMemberAccent(channelId: string): MemberAccent {
  const index = hashString(channelId) % PALETTE.length
  return PALETTE[index]
}
