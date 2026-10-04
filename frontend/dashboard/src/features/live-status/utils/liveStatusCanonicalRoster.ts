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

function isOrganizationChannel(creator: CanonicalCreator): boolean {
  return creator.channelType !== "member" && creator.groupKey[0] === NO_GROUP_KEY
}

/** Inside one named group/unit: individual members first, then that group's own
 * channel(s) (e.g. hololive ReGLOSS after the ReGLOSS members) -- stable, so the
 * existing order inside each half is preserved. Applied per subgroup, never across
 * the roster, so a unit channel stays in its own group instead of a global section. */
function membersBeforeNonMembers(creators: CanonicalCreator[]): CanonicalCreator[] {
  return [
    ...creators.filter((creator) => creator.channelType === "member"),
    ...creators.filter((creator) => creator.channelType !== "member"),
  ]
}

/** One branch's subgroups. Organization-level channels (vspo_official, hololive_official)
 * are taken out BEFORE the shared grouping -- which would otherwise drop an unrecognized
 * groupKey like "NO" into the catch-all "Other" bucket -- and placed after the last named
 * group as the branch's final row: at the bottom of the single list in a flat branch
 * (VSPO JP), and as their own trailing unlabeled block after "Other" in a grouped branch
 * (Hololive JP), so "Other" holds only its own channels. */
function branchSubgroups(branch: BranchKey, creators: CanonicalCreator[]): Subgroup<CanonicalCreator>[] {
  const organizationChannels = creators.filter(isOrganizationChannel)
  const subgroups = subgroupsForBranch(
    branch,
    creators.filter((creator) => !isOrganizationChannel(creator)),
    (creator) => creator.displayName,
  ).map((subgroup) => ({ ...subgroup, creators: membersBeforeNonMembers(subgroup.creators) }))

  if (organizationChannels.length === 0) return subgroups
  const [only] = subgroups
  if (subgroups.length === 1 && only.label === null) {
    return [{ ...only, creators: [...only.creators, ...organizationChannels] }]
  }
  return [...subgroups, { label: null, creators: organizationChannels }]
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
 * Placement: a unit/group channel sits at the bottom of its own group, below
 * that group's individual members (hololive ReGLOSS last in ReGLOSS). The
 * catch-all "Other" bucket (ACHRORA, holoAN room, UNIT B) is the final named
 * Hololive JP group, which subgroupsForBranch already emits last. The
 * organization-level channels come after everything else in their branch:
 * vspo_official last in VSPO JP, hololive Official last in Hololive JP, after
 * "Other" (see branchSubgroups).
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
    subgroups: branchSubgroups(
      branch,
      filtered.filter((creator) => creator.branch === branch),
    ),
  })).filter((group) => group.subgroups.length > 0)
}
