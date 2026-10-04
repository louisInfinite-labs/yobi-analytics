import { getCreators, isLiveStatusDisplayEligible } from "../../../entities/creator/data/creatorRegistry"
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

/** The placeholder groupKey the canonical master gives a channel that belongs to no
 * generation/unit (backend creators.json: "a single-element placeholder like ["NO"]
 * where the concept doesn't apply"). For a non-member channel it identifies the
 * ORGANIZATION-level official channel (vspo_official, hololive_official) -- as opposed
 * to a unit/generation channel such as hololive ReGLOSS, whose groupKey names its unit. */
const NO_GROUP_KEY = "NO"

function placementTier(creator: CanonicalCreator): number {
  if (creator.channelType === "member") return 0
  return creator.groupKey[0] === NO_GROUP_KEY ? 2 : 1
}

/** Inside one subgroup: individual members first, then unit/staff channels, then the
 * organization-level official channel -- preserving the relative order within each tier.
 * Applied inside every subgroup (never across the whole roster), so a non-member channel
 * stays in the group it belongs to -- VSPO JP's own list, ReGLOSS, FLOW GLOW, Advent,
 * Hololive JP's "Other" -- pinned to that group's bottom, instead of being collected into
 * one global non-member section. Data-driven (channelType + groupKey), never a creatorId. */
function membersBeforeNonMembers(creators: CanonicalCreator[]): CanonicalCreator[] {
  return [...creators].sort((a, b) => placementTier(a) - placementTier(b))
}

/** Live Status' own canonical-registry roster grouping -- deliberately a
 * separate function from dockCreatorOrder.ts's groupCreatorsForDockWithSubgroups,
 * which stays untouched and still backs Dashboard Comparison (out of this
 * migration's scope) against mockCreators. Groups by branch, then Agency's
 * own Generation/Unit subgroups via the SAME shared subgroupsForBranch
 * algorithm every other migrated page already uses (My Oshi, Favorites) --
 * this is what keeps the アソビ★まわり隊！ subgroup fix visible here too.
 *
 * Live Status is the SUPPORTED CHANNEL roster, so it applies
 * isLiveStatusDisplayEligible -- every channel in the canonical registry:
 * active/pre-debut members, graduated members (each stays in her original
 * generation/unit; there is no separate "Graduated" group), and group/staff
 * channels such as vspo_official. It does NOT depend on lifecycle, channel
 * type, or any video/ranking/manifest data; a channel with no stream data
 * simply renders OFFLINE (see useCreatorStatuses). This is intentionally NOT
 * the My Oshi rule (isMyOshiEligible), which excludes group/staff channels.
 *
 * Placement: every group/staff channel stays inside its own group, below that
 * group's individual members (membersBeforeNonMembers, per subgroup) -- e.g.
 * vspo_official last in VSPO JP, hololive ReGLOSS last in ReGLOSS, and the
 * catch-all "Other" bucket (ACHRORA, holoAN room, UNIT B, then the organization-
 * level hololive Official channel last) as the final Hololive JP group, which
 * subgroupsForBranch already emits last.
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
        isLiveStatusDisplayEligible(creator) && creatorMatchesSearch(creator, query) && (!filterCreator || filterCreator(creator)),
    )
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder)

  return DOCK_BRANCH_ORDER.map((branch) => ({
    branch,
    subgroups: subgroupsForBranch(branch, filtered.filter((creator) => creator.branch === branch), (creator) => creator.displayName).map(
      (subgroup) => ({ ...subgroup, creators: membersBeforeNonMembers(subgroup.creators) }),
    ),
  })).filter((group) => group.subgroups.length > 0)
}
