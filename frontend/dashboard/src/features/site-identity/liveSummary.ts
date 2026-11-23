import { getCreators, toLegacyRosterId } from "../../entities/creator/data/creatorRegistry"
import type { CreatorStatus } from "../live-status/model/creatorStatus"
import type { SiteIntroCopy } from "./siteIntroCopy"

/** How many live creators are named before the rest are counted. */
const MAX_LIVE_NAMES = 6

/** The live line under Home's heading, from the shared /live-streams data the page already has (no request of its own): who is live now (in
 * the registry's order, the first few by name) and how many creators start within the next 24 hours (the Live Status window). Before this
 * session's first response -- or when it failed -- it says nothing about anyone: a neutral dash. */
export function liveSummaryLines(statuses: Record<string, CreatorStatus>, statusKnown: boolean, copy: SiteIntroCopy): string[] {
  if (!statusKnown) return [copy.liveUnknown]
  const creators = getCreators()
  const live = creators.filter((creator) => statuses[toLegacyRosterId(creator)]?.kind === "live")
  const upcoming = creators.filter((creator) => statuses[toLegacyRosterId(creator)]?.kind === "upcoming").length
  const names = live.slice(0, MAX_LIVE_NAMES).map((creator) => creator.displayName.replace(/\n/g, " "))
  const rest = live.length - names.length
  const liveLine =
    live.length === 0 ? copy.liveNone : copy.liveNow(live.length, names.join(copy.nameSeparator) + (rest > 0 ? copy.nameSeparator + copy.moreNames(rest) : ""))
  return [liveLine, copy.upcoming(upcoming)]
}
