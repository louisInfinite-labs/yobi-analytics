import type { CSSProperties } from "react"
import { mockCreators } from "../../entities/creator/data/mockCreators"
import { getMemberAccent } from "./memberAccent"

/** Binds --creator-main/--creator-sub to whichever creator is being viewed
 * (currentOshi), reading the app's one existing per-creator color source
 * (getMemberAccent, itself backed by Creator Master's verified themeColor
 * when one exists) rather than a second theme registry. */
export function creatorThemeStyle(channelId: string): CSSProperties {
  const creator = mockCreators.find((entry) => entry.channelId === channelId)
  const accent = getMemberAccent(channelId, creator?.themeColor)
  return {
    "--creator-main": accent.primary,
    "--creator-sub": accent.textAccent,
  } as CSSProperties
}
