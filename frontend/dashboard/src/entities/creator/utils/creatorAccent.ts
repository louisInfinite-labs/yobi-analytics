import type { CanonicalCreator } from "../model/creatorMaster"
import { getMemberAccent, type MemberAccent } from "../../../shared/theme/memberAccent"
import { toLegacyRosterId } from "../data/creatorRegistry"

/** A creator's accent color -- THE one resolution every roster surface uses (My Favorites / 收藏名單 and the Notification Members drawer).
 *
 * It is exactly what Favorites has always computed: the creator's verified `themeColor` from the canonical registry when there is one,
 * otherwise the deterministic hashed palette fallback seeded with the legacy roster id (`toLegacyRosterId`, not the creatorId or the YouTube
 * channel id), so a creator without a verified color keeps the very same fallback accent as before the registry migration. A surface must
 * never derive a creator's color any other way -- not from the organization or group, not from the avatar, not from a color table of its own
 * -- or the same creator shows two different colors across the app. */
export function getCreatorAccent(creator: Pick<CanonicalCreator, "creatorId" | "themeColor">): MemberAccent {
  return getMemberAccent(toLegacyRosterId(creator), creator.themeColor)
}
