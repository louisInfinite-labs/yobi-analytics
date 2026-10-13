// How many of a slot's stream avatars are drawn before the rest collapse into the "+N" control.
//
// The multi-day grid has always used a fixed rule (up to 4 streams show every avatar; more than 4 show 3 and "+N"), which assumed a column
// wide enough for them. That is not true of a narrow tablet column, and a phone's single day column is much WIDER than a desktop one, so a
// fixed count is wrong in both directions. The decision is therefore made from the width the slot really has:
// - a layout that always had the fixed rule (the multi-day grid) keeps it as an UPPER bound, so a wide screen looks exactly as before and a
//   narrow one can only show fewer, never overflow;
// - the single-day phone layout has no such bound: it shows as many avatars as fit beside the "+N" chip.

/** Mirrors `.stream-avatar-group`'s `gap` in schedule.css (scheduleOverflow.css.test.ts keeps the two equal). */
export const AVATAR_GAP_PX = 4
/** Fallback for `--creator-avatar-size` (shared/styles/creatorAvatar.css) when it cannot be read. */
export const DEFAULT_AVATAR_SIZE_PX = 36
/** `.more-streams`' `min-width` in schedule.css; a chip with a longer label ("+10", "+100") grows past it (see moreChipWidth). */
export const MORE_CHIP_MIN_WIDTH_PX = 35

// The fixed rule the multi-day grid has always had: a slot with MORE than 4 streams shows 3 avatars and "+N".
export const MAX_AVATARS_BEFORE_OVERFLOW = 4
export const VISIBLE_AVATARS_WHEN_OVERFLOWING = 3

/** The rendered width of a "+N" chip that hides `hidden` streams: its 35px minimum for one digit, then the label's own width plus the chip's
 * 9px side padding (measured: "+10" is 39.5px, "+100" about 46px). */
export function moreChipWidth(hidden: number): number {
  if (hidden < 10) return MORE_CHIP_MIN_WIDTH_PX
  if (hidden < 100) return 40
  return 46
}

export interface AvatarOverflowOptions {
  /** The width the avatar group may use, or null when it is not known (no layout yet): then only the fixed rule applies. */
  availableWidth: number | null
  /** Whether the fixed rule above still bounds the count (multi-day grid) or only the width does (single-day phone layout). */
  boundedByFixedRule: boolean
  avatarSize?: number
}

/** The number of avatars to draw out of `total`; the remaining `total - result` go behind "+N" (0 hidden = no chip). */
export function visibleAvatarCount(total: number, { availableWidth, boundedByFixedRule, avatarSize = DEFAULT_AVATAR_SIZE_PX }: AvatarOverflowOptions): number {
  if (total <= 0) return 0
  const ruleVisible = total > MAX_AVATARS_BEFORE_OVERFLOW ? VISIBLE_AVATARS_WHEN_OVERFLOWING : total
  const fixedRuleBound = boundedByFixedRule ? ruleVisible : total
  if (availableWidth === null || !Number.isFinite(availableWidth) || availableWidth <= 0) return fixedRuleBound

  const step = avatarSize + AVATAR_GAP_PX
  const widthOfAll = total * avatarSize + (total - 1) * AVATAR_GAP_PX
  if (fixedRuleBound === total && widthOfAll <= availableWidth) return total // everything fits: no "+N" at all

  // Some stream is hidden, so the chip follows the visible avatars: n avatars (each followed by a gap) + the chip must fit. The chip's width
  // depends on how many streams it hides, so try the most avatars first and take the first count that fits.
  for (let visible = fixedRuleBound === total ? total - 1 : fixedRuleBound; visible > 0; visible--) {
    if (visible * step + moreChipWidth(total - visible) <= availableWidth) return visible
  }
  return 0
}
