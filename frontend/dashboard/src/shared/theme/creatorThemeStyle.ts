import type { CSSProperties } from "react"
import { getMemberAccent } from "./memberAccent"

/** Binds --creator-main/--creator-sub to whichever creator is being viewed
 * (currentOshi), reading the app's one existing per-creator color source
 * (getMemberAccent) rather than a second theme registry. */
export function creatorThemeStyle(channelId: string): CSSProperties {
  const accent = getMemberAccent(channelId)
  return {
    "--creator-main": accent.primary,
    "--creator-sub": accent.textAccent,
  } as CSSProperties
}
