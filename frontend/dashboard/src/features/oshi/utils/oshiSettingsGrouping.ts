import { getCreators } from "../../../entities/creator/data/creatorRegistry"
import type { CanonicalCreator } from "../../../entities/creator/model/creatorMaster"
import type { BranchKey } from "../../../entities/creator/model/domain"
import { DOCK_BRANCH_ORDER, pinNonMemberChannelsLast } from "../../../entities/creator/utils/dockCreatorOrder"
import { GAMERS_GROUP_LABEL_KEY, OTHER_GROUP_LABEL_KEY, subgroupsForBranch, type Subgroup } from "../../../entities/creator/utils/hololiveSubgrouping"

export { GAMERS_GROUP_LABEL_KEY, OTHER_GROUP_LABEL_KEY }

export interface OshiSettingsRegionGroup {
  branch: BranchKey
  /** "JP" / "EN" / "ID" -- one level below Agency, above Generation/Unit. */
  regionLabel: string
  subgroups: Subgroup<CanonicalCreator>[]
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

/** Case-insensitive match against the creator's canonical display name --
 * the canonical-registry counterpart of dockCreatorOrder.ts's own
 * creatorMatchesSearch (kept separate rather than generalizing that one:
 * it's shared Live Status/Dock infrastructure, out of this migration's
 * scope, and is keyed on MockCreator.channelName, not displayName). */
function creatorMatchesSearch(creator: CanonicalCreator, query: string): boolean {
  if (query.trim() === "") return true
  return creator.displayName.toLowerCase().includes(query.trim().toLowerCase())
}

/** Oshi Settings' own creator grouping (C8B: migrated to the canonical
 * Creator Registry -- getCreators(), never mockCreators) -- nested Agency >
 * Region > Generation/Unit via the same shared subgroupsForBranch algorithm
 * Notification Settings and My Oshi (myOshiCanonicalRoster.ts) already use,
 * so all three group Hololive JP/EN/ID identically. Unlike My Oshi, this
 * roster applies NO eligibility filter of its own -- Favorites has always
 * let every creator (including group/staff channels) be favorited, and C8B
 * deliberately preserves that rather than adopting My Oshi's
 * isCurrentMemberEligible rule.
 *
 * Ordered by canonical displayOrder (C8A0) ascending -- getCreators()'s own
 * array order is alphabetical-by-creatorId for deterministic codegen, never
 * a display order, so it is sorted here before branch/subgroup
 * partitioning, same as myOshiCanonicalRoster.ts.
 *
 * Search is applied BEFORE grouping (matching NotificationSettings' own
 * "filter the hierarchy, not just the rows" fix): a subgroup/region/agency
 * with zero matching creators simply never appears, so a search never
 * leaves an empty "VSPO"/"Hololive"/"JP"/"1期生" heading on screen.
 *
 * `filterCreator`, if given, is ANDed into that same pre-grouping filter --
 * used by OshiSettings.tsx's own "Favorites only" view filter. */
export function groupCreatorsForOshiSettings(
  query: string,
  filterCreator?: (creator: CanonicalCreator) => boolean,
): OshiSettingsAgencyGroup[] {
  const filtered = [...getCreators()]
    .filter((creator) => creatorMatchesSearch(creator, query) && (!filterCreator || filterCreator(creator)))
    .sort((a, b) => a.displayOrder - b.displayOrder)

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
      // is untouched. Still meaningful here (unlike My Oshi's own
      // myOshiCanonicalRoster.ts, where eligibility already excludes every
      // non-member) since Favorites keeps non-member creators visible.
      subgroups: subgroupsForBranch(branch, branch === "vspo_jp" ? pinNonMemberChannelsLast(branchCreators) : branchCreators, (c) => c.displayName),
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
