import { mockCreators, type MockCreator } from "../../../entities/creator/data/mockCreators"
import type { BranchKey } from "../../../entities/creator/model/domain"
import { DOCK_BRANCH_ORDER, creatorMatchesSearch, pinNonMemberChannelsLast } from "../../../entities/creator/utils/dockCreatorOrder"
import { GAMERS_GROUP_LABEL_KEY, OTHER_GROUP_LABEL_KEY, subgroupsForBranch, type Subgroup } from "../../../entities/creator/utils/hololiveSubgrouping"

export { GAMERS_GROUP_LABEL_KEY, OTHER_GROUP_LABEL_KEY }

export interface OshiSettingsRegionGroup {
  branch: BranchKey
  /** "JP" / "EN" / "ID" -- one level below Agency, above Generation/Unit. */
  regionLabel: string
  subgroups: Subgroup<MockCreator>[]
}

export interface OshiSettingsAgencyGroup {
  /** "VSPO" / "Hololive" -- this feature's own top-level heading. */
  agencyLabel: string
  regions: OshiSettingsRegionGroup[]
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

/** Oshi Settings' own creator grouping -- reuses Live Status's existing
 * roster (mockCreators) and branch order (DOCK_BRANCH_ORDER in
 * dockCreatorOrder.ts), nested one level deeper into Agency > Region >
 * Generation/Unit for this page's own three-level display, using the exact
 * same subgrouping algorithm as Notification Settings (numbered
 * generations, the Gamers dual-bucket rule, FLOWGLOW/ReGLOSS
 * group-channel-first, Hololive EN's fixed unit order, and an
 * alphabetically-sorted "Other" catch-all) so both pages group and order
 * creators identically. Same creators/IDs Live Status itself already
 * groups by -- a favorite toggled here is immediately visible there and
 * vice versa.
 *
 * Search is applied BEFORE grouping (matching NotificationSettings' own
 * "filter the hierarchy, not just the rows" fix): a subgroup/region/agency
 * with zero matching creators simply never appears, so a search never
 * leaves an empty "VSPO"/"Hololive"/"JP"/"1期生" heading on screen.
 *
 * `filterCreator`, if given, is ANDed into that same pre-grouping filter --
 * used by MyOshiSettings.tsx to additionally drop ineligible creators (see
 * lib/myOshiEligibility.ts) while still sharing this exact grouping/layout
 * with the plain Favorites List page (whose own call site omits it,
 * unaffected). */
export function groupCreatorsForOshiSettings(
  query: string,
  filterCreator?: (creator: MockCreator) => boolean,
): OshiSettingsAgencyGroup[] {
  const filtered = mockCreators.filter(
    (creator) => creatorMatchesSearch(creator, query) && (!filterCreator || filterCreator(creator)),
  )

  const regions: OshiSettingsRegionGroup[] = DOCK_BRANCH_ORDER.map((branch) => {
    const branchCreators = filtered.filter((creator) => creator.branch === branch)
    return {
      branch,
      regionLabel: REGION_LABEL_BY_BRANCH[branch],
      // VSPO JP's own official channel (VSPO! Official) is pinned to the
      // very bottom of this branch's list -- confirmed with the user,
      // reusing the exact same rule Live Status and Notification Settings
      // both apply (dockCreatorOrder.ts's own pinNonMemberChannelsLast),
      // not a second copy of it. Every other branch's own existing order
      // is untouched.
      subgroups: subgroupsForBranch(branch, branch === "vspo_jp" ? pinNonMemberChannelsLast(branchCreators) : branchCreators, (c) => c.channelName),
    }
  }).filter((region) => region.subgroups.length > 0)

  const agencies: OshiSettingsAgencyGroup[] = []
  for (const region of regions) {
    const agencyLabel = agencyLabelForBranch(region.branch)
    const existing = agencies.find((agency) => agency.agencyLabel === agencyLabel)
    if (existing) existing.regions.push(region)
    else agencies.push({ agencyLabel, regions: [region] })
  }
  return agencies
}
