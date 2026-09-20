import type { MockCreator } from "../../../entities/creator/data/mockCreators"

/** Settings > 我推設定 only ever offers an individual member as the
 * selectable Oshi -- confirmed with the user: excludes hololive Production
 * Staff (channelType "staff" -- e.g. "hololive Production Staff" and
 * "holoAN room", neither an individual creator) and VSPO's own official
 * channel ("VSPO! Official", the one non-member channelType entry in the
 * vspo_jp branch -- detected the same channelType-based, non-hardcoded-id
 * way dockCreatorOrder.ts's own pinNonMemberChannelsLast already does).
 * Hololive's own "group" channelType entries (ReGLOSS/FLOWGLOW/FUWAMOCO/
 * the mekPark units) are NOT excluded by this rule -- those are real,
 * already-selectable member-composed channels elsewhere in the app. */
export function isEligibleForMyOshi(creator: MockCreator): boolean {
  if (creator.channelType === "staff") return false
  if (creator.branch === "vspo_jp" && creator.channelType !== "member") return false
  return true
}
