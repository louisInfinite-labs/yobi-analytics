import { getCreators, isCurrentMemberEligible } from "../../../entities/creator/data/creatorRegistry"
import type { CanonicalCreator } from "../../../entities/creator/model/creatorMaster"
import type { BranchKey } from "../../../entities/creator/model/domain"
import { DOCK_BRANCH_ORDER } from "../../../entities/creator/utils/dockCreatorOrder"
import { GAMERS_GROUP_LABEL_KEY, OTHER_GROUP_LABEL_KEY, subgroupsForBranch, type Subgroup } from "../../../entities/creator/utils/hololiveSubgrouping"

export { GAMERS_GROUP_LABEL_KEY, OTHER_GROUP_LABEL_KEY }

export interface MyOshiRegionGroup {
  branch: BranchKey
  /** "JP" / "EN" / "ID" -- one level below Agency, above Generation/Unit. */
  regionLabel: string
  subgroups: Subgroup<CanonicalCreator>[]
}

export interface MyOshiAgencyGroup {
  /** "VSPO" / "Hololive" -- this feature's own top-level heading. */
  agencyLabel: string
  regions: MyOshiRegionGroup[]
}

const REGION_LABEL_BY_BRANCH: Record<BranchKey, string> = {
  vspo_jp: "JP",
  vspo_en: "EN",
  holo_jp: "JP",
  holo_en: "EN",
  holo_id: "ID",
}

function agencyLabelForBranch(branch: BranchKey): string {
  return branch.startsWith("vspo_") ? "VSPO" : "Hololive"
}

function matchesSearch(creator: CanonicalCreator, query: string): boolean {
  if (query.trim() === "") return true
  return creator.displayName.toLowerCase().includes(query.trim().toLowerCase())
}

/** My Oshi's own canonical-registry roster grouping (C8A) -- deliberately a
 * separate function from oshiSettingsGrouping.ts's groupCreatorsForOshiSettings,
 * which stays untouched and still backs the Favorites page (OshiSettings.tsx,
 * out of this migration's scope) against mockCreators. Groups Agency > Region
 * > Generation/Unit via the SAME shared subgroupsForBranch algorithm those
 * pages already use, so the visible grouping shape is identical -- only the
 * data source, eligibility rule, and per-subgroup order (displayOrder
 * ascending, C8A0) differ.
 *
 * isCurrentMemberEligible already excludes every non-"member" channelType, so
 * -- unlike oshiSettingsGrouping.ts's own pinNonMemberChannelsLast for VSPO
 * JP -- there is never a non-member creator left in this filtered roster to
 * pin last; that step is simply omitted here rather than called on an input
 * that could never contain one. */
export function groupSelectableCreatorsForMyOshi(query: string): MyOshiAgencyGroup[] {
  const filtered = getCreators()
    .filter((creator) => isCurrentMemberEligible(creator) && matchesSearch(creator, query))
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder)

  const regions: MyOshiRegionGroup[] = DOCK_BRANCH_ORDER.map((branch) => {
    const branchCreators = filtered.filter((creator) => creator.branch === branch)
    return {
      branch,
      regionLabel: REGION_LABEL_BY_BRANCH[branch],
      subgroups: subgroupsForBranch(branch, branchCreators, (creator) => creator.displayName),
    }
  }).filter((region) => region.subgroups.length > 0)

  const agencies: MyOshiAgencyGroup[] = []
  for (const region of regions) {
    const agencyLabel = agencyLabelForBranch(region.branch)
    const existing = agencies.find((agency) => agency.agencyLabel === agencyLabel)
    if (existing) existing.regions.push(region)
    else agencies.push({ agencyLabel, regions: [region] })
  }
  return agencies
}
