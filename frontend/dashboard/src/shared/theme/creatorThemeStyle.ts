import type { CSSProperties } from "react"
import { getMemberAccent } from "./memberAccent"

/** Binds --creator-main/--creator-sub to whichever creator is being viewed
 * (currentOshi), reading the app's one existing per-creator color source
 * (getMemberAccent, itself backed by Creator Master's verified themeColor
 * when one exists) rather than a second theme registry. `themeColor` is the
 * caller's own already-resolved creator's color (whatever frontend creator
 * source that caller already reads from) -- this helper does not look a
 * creator record up on its own, so it never becomes a second, hidden route
 * into that data. */
export function creatorThemeStyle(channelId: string, themeColor?: string | null): CSSProperties {
  const accent = getMemberAccent(channelId, themeColor)
  return {
    "--creator-main": accent.primary,
    "--creator-sub": accent.textAccent,
  } as CSSProperties
}
