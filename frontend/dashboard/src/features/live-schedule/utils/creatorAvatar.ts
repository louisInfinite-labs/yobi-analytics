import { resolveCreatorKey, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { getMemberAccent } from "../../../shared/theme/memberAccent"

export interface ScheduleCreatorAvatarVisual {
  avatarUrl?: string
  initial: string
  background: string
  color: string
}

/** Schedule-only counterpart of features/analytics/charts/CreatorAvatar.tsx's
 * getCreatorAvatarVisual: that function still reads mockCreators (whose
 * avatarUrl is always unset) and is shared with Dashboard Comparison, so it
 * can't be changed here without affecting that feature. This instead
 * resolves a stream's channelId against the real Creator Registry (the same
 * source Live Status's own CreatorAvatar already reads avatarUrl/themeColor
 * from), and falls back to the existing hashed-initial placeholder --
 * unresolved via resolveCreatorKey never throws -- when the id can't be
 * resolved to a real creator. */
export function getScheduleCreatorAvatarVisual(channelId: string, fallbackName: string): ScheduleCreatorAvatarVisual {
  const creator = resolveCreatorKey(channelId)
  const accent = creator ? getMemberAccent(toLegacyRosterId(creator), creator.themeColor) : getMemberAccent(channelId)
  const initialSource = (creator?.displayName ?? fallbackName).replace(/\n/g, " ").trim()
  return {
    avatarUrl: creator?.avatarUrl ?? undefined,
    initial: initialSource.charAt(0).toUpperCase() || "?",
    background: accent.primary,
    color: accent.textAccent,
  }
}
