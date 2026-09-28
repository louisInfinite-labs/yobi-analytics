import { getCreators, isCurrentMemberEligible } from "../../../entities/creator/data/creatorRegistry"
import type { CanonicalCreator } from "../../../entities/creator/model/creatorMaster"
import type { BranchKey } from "../../../entities/creator/model/domain"
import { DOCK_BRANCH_ORDER } from "../../../entities/creator/utils/dockCreatorOrder"
import { subgroupsForBranch, type Subgroup } from "../../../entities/creator/utils/hololiveSubgrouping"

export interface LiveStatusBranchGroup {
  branch: BranchKey
  subgroups: Subgroup<CanonicalCreator>[]
}

/** Case-insensitive match against the creator's canonical display name --
 * the canonical-registry counterpart of dockCreatorOrder.ts's own
 * creatorMatchesSearch (kept separate rather than generalizing that one:
 * it's still shared with Dashboard Comparison, out of this migration's
 * scope, and is keyed on MockCreator.channelName, not displayName). */
export function creatorMatchesSearch(creator: CanonicalCreator, query: string): boolean {
  if (query.trim() === "") return true
  return creator.displayName.toLowerCase().includes(query.trim().toLowerCase())
}

/** Live Status' own canonical-registry roster grouping (C8C) -- deliberately
 * a separate function from dockCreatorOrder.ts's groupCreatorsForDockWithSubgroups,
 * which stays untouched and still backs Dashboard Comparison (out of this
 * migration's scope) against mockCreators. Groups by branch, then Agency's
 * own Generation/Unit subgroups via the SAME shared subgroupsForBranch
 * algorithm every other migrated page already uses (My Oshi, Favorites) --
 * this is what keeps the アソビ★まわり隊！ subgroup fix visible here too.
 *
 * Live Status is a CURRENT creator/live roster, so it applies
 * isCurrentMemberEligible -- same rule as My Oshi, unlike Favorites (C8B),
 * which applies none. Since eligibility already excludes every non-"member"
 * channelType, there is never a non-member creator left to pin last
 * (dockCreatorOrder.ts's own pinNonMemberChannelsLast is therefore not
 * needed here, same reasoning as myOshiCanonicalRoster.ts).
 *
 * Ordered by canonical displayOrder (C8A0) ascending -- getCreators()'s own
 * array order is alphabetical-by-creatorId for deterministic codegen, never
 * a display order.
 *
 * `filterCreator`, if given, is ANDed into the same pre-grouping filter as
 * search -- used by CreatorStatusList's own Favorites-only view filter. */
export function groupEligibleCreatorsForLiveStatus(
  query: string,
  filterCreator?: (creator: CanonicalCreator) => boolean,
): LiveStatusBranchGroup[] {
  const filtered = getCreators()
    .filter(
      (creator) =>
        isCurrentMemberEligible(creator) && creatorMatchesSearch(creator, query) && (!filterCreator || filterCreator(creator)),
    )
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder)

  return DOCK_BRANCH_ORDER.map((branch) => ({
    branch,
    subgroups: subgroupsForBranch(branch, filtered.filter((creator) => creator.branch === branch), (creator) => creator.displayName),
  })).filter((group) => group.subgroups.length > 0)
}
