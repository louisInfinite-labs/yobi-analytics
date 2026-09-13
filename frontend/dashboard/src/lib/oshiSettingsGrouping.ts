import { mockCreators, type MockCreator } from "../data/mockCreators"
import type { BranchKey } from "../types/domain"
import { DOCK_BRANCH_ORDER, creatorMatchesSearch } from "./dockCreatorOrder"
import {
  GAMERS_GROUP_LABEL_KEY,
  groupByFixedOrThenNumbered,
  groupFlat,
  groupHololiveJp,
  HOLOLIVE_EN_FIXED_ORDER,
  OTHER_GROUP_LABEL_KEY,
  type Subgroup,
} from "./hololiveSubgrouping"

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

/** Same Agency>Region>Generation/Unit grouping algorithm as Notification
 * Settings (see hololiveSubgrouping.ts -- shared, not a second parallel
 * copy), applied to Live Status's own roster (mockCreators) instead of the
 * real creators.json one, so favorites stay keyed by the same `channelId`
 * Live Status itself already uses (useFavoriteCreators) -- no separate ID
 * space, no mapping table. */
function subgroupsForBranch(branch: BranchKey, creators: MockCreator[]): Subgroup<MockCreator>[] {
  switch (branch) {
    case "holo_jp":
      return groupHololiveJp(creators, (c) => c.channelName)
    case "holo_en":
      return groupByFixedOrThenNumbered(creators, HOLOLIVE_EN_FIXED_ORDER)
    case "holo_id":
      return groupByFixedOrThenNumbered(creators, [])
    case "vspo_jp":
    case "vspo_en":
      return groupFlat(creators)
  }
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
 * leaves an empty "VSPO"/"Hololive"/"JP"/"1期生" heading on screen. */
export function groupCreatorsForOshiSettings(query: string): OshiSettingsAgencyGroup[] {
  const filtered = mockCreators.filter((creator) => creatorMatchesSearch(creator, query))

  const regions: OshiSettingsRegionGroup[] = DOCK_BRANCH_ORDER.map((branch) => ({
    branch,
    regionLabel: REGION_LABEL_BY_BRANCH[branch],
    subgroups: subgroupsForBranch(
      branch,
      filtered.filter((creator) => creator.branch === branch),
    ),
  })).filter((region) => region.subgroups.length > 0)

  const agencies: OshiSettingsAgencyGroup[] = []
  for (const region of regions) {
    const agencyLabel = agencyLabelForBranch(region.branch)
    const existing = agencies.find((agency) => agency.agencyLabel === agencyLabel)
    if (existing) existing.regions.push(region)
    else agencies.push({ agencyLabel, regions: [region] })
  }
  return agencies
}
