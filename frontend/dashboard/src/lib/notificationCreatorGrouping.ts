import rawCreators from "../data/creators.json"
import {
  GAMERS_GROUP_LABEL_KEY,
  groupByFixedOrThenNumbered,
  groupFlat,
  groupHololiveJp,
  HOLOLIVE_EN_FIXED_ORDER,
  OTHER_GROUP_LABEL_KEY,
  type Subgroup,
} from "./hololiveSubgrouping"
import type { BranchKey } from "../types/domain"

export { GAMERS_GROUP_LABEL_KEY, OTHER_GROUP_LABEL_KEY }

/** The real Creator Master roster (backend's src/creators.json, copied
 * here as this app's only source for "every creator" -- 112 entries as of
 * this copy, not the small ~13-entry frontend mockCreators.ts used
 * elsewhere for Home/Dock demos). */
export interface NotificationCreator {
  creatorId: string
  displayName: string
  organization: "hololive" | "vspo"
  youtubeChannelId: string
  active: boolean
  branch: BranchKey
  channelType: "member" | "group" | "staff"
  lifecycleStage: "active" | "pre_debut" | "graduated" | "retired"
  groupKey: string[]
  discoveryEnabled?: boolean
  graduatedAt?: string | null
}

/** Display-only correction, never touching creators.json itself, applied
 * the same regardless of the app's active locale (a creator's real name
 * proper noun, not translated UI text).
 * - hololive_dev_is_regloss/hololive_dev_is_flow_glow: that file's own
 *   `displayName` is "hololive DEV_IS ReGLOSS"/"hololive DEV_IS FLOW
 *   GLOW", but the real YouTube channels (youtube.com/@hololiveDEV_IS,
 *   confirmed as ReGLOSS's own channel, and youtube.com/@DEV_IS_FLOWGLOW)
 *   are actually named "hololive ReGLOSS"/"hololive FLOW GLOW" -- no
 *   "DEV_IS" in the middle. Confirmed directly against the real
 *   channels, not guessed.
 * - unit_b_pre_debut/achrora: confirmed real channel naming adds a
 *   " - mekPark" suffix (and a space before the parenthesis for UNIT B)
 *   that creators.json's own displayName is missing.
 * - VSPO! EN's 7 talents (remia_aotsuki through juno_umezono): each has a
 *   real Japanese name, confirmed directly from vspo.jp's own member page
 *   (its image alt text carries the Japanese name, shown as the page's
 *   own big heading, with the English name only as a smaller badge
 *   underneath) -- shown here in preference to the English name, fixed
 *   across every locale. Not applicable to hololive EN (Myth/Promise/
 *   Advent/Justice members carry no separate Japanese name in any
 *   official source checked). */
const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  hololive_dev_is_regloss: "hololive ReGLOSS",
  hololive_dev_is_flow_glow: "hololive FLOW GLOW",
  unit_b_pre_debut: "UNIT B (Pre-Debut) - mekPark",
  achrora: "ACHRORA - mekPark",
  remia_aotsuki: "青月レミア",
  arya_kuroha: "黒刃アリヤ",
  jira_jisaki: "地崎ジラ",
  narin_mikure: "美暮ナリン",
  riko_solari: "ソラリリコ",
  eris_suzukami: "涼上エリス",
  juno_umezono: "梅園ジュノ",
}

function withDisplayNameOverride(creator: NotificationCreator): NotificationCreator {
  const override = DISPLAY_NAME_OVERRIDES[creator.creatorId]
  return override ? { ...creator, displayName: override } : creator
}

const ALL_CREATORS = (rawCreators as NotificationCreator[]).map(withDisplayNameOverride)

export interface CreatorSubgroup {
  /** null for a branch with no generation/unit subdivision (VSPO JP/EN,
   * per this feature's own spec) -- rendered with no subgroup header. */
  label: string | null
  creators: NotificationCreator[]
}

export interface CreatorRegionGroup {
  branch: BranchKey
  /** "JP" / "EN" / "ID" -- the spec's own Region heading, one level below
   * Agency and above Generation/Unit. */
  regionLabel: string
  subgroups: CreatorSubgroup[]
}

export interface CreatorAgencyGroup {
  /** "VSPO" / "HOLOLIVE" -- the spec's own top-level Agency heading. */
  agencyLabel: string
  regions: CreatorRegionGroup[]
}

/** Agency > Region display order, this feature's own spec order (VSPO
 * before HOLOLIVE; JP before EN before ID within each). */
const AGENCY_REGION_ORDER: { agencyLabel: string; branch: BranchKey; regionLabel: string }[] = [
  { agencyLabel: "VSPO", branch: "vspo_jp", regionLabel: "JP" },
  { agencyLabel: "VSPO", branch: "vspo_en", regionLabel: "EN" },
  { agencyLabel: "HOLOLIVE", branch: "holo_jp", regionLabel: "JP" },
  { agencyLabel: "HOLOLIVE", branch: "holo_en", regionLabel: "EN" },
  { agencyLabel: "HOLOLIVE", branch: "holo_id", regionLabel: "ID" },
]

function subgroupsForBranch(branch: BranchKey, creators: NotificationCreator[]): Subgroup<NotificationCreator>[] {
  switch (branch) {
    case "holo_jp":
      return groupHololiveJp(creators, (c) => c.displayName)
    case "holo_en":
      return groupByFixedOrThenNumbered(creators, HOLOLIVE_EN_FIXED_ORDER)
    case "holo_id":
      return groupByFixedOrThenNumbered(creators, [])
    case "vspo_jp":
    case "vspo_en":
      return groupFlat(creators)
  }
}

/** Every creator in the roster, grouped into the spec's own three-level
 * tree -- Agency (VSPO/HOLOLIVE) > Region (JP/EN/ID) > Generation/Unit >
 * Creators -- in the spec's own fixed order (AGENCY_REGION_ORDER). */
export function groupCreatorsForNotificationSettings(): CreatorAgencyGroup[] {
  const regionGroups: CreatorRegionGroup[] = AGENCY_REGION_ORDER.map(({ branch, regionLabel }) => ({
    branch,
    regionLabel,
    subgroups: subgroupsForBranch(
      branch,
      ALL_CREATORS.filter((creator) => creator.branch === branch),
    ),
  })).filter((region) => region.subgroups.length > 0)

  const agencyLabels = [...new Set(AGENCY_REGION_ORDER.map((entry) => entry.agencyLabel))]
  return agencyLabels
    .map((agencyLabel) => ({
      agencyLabel,
      regions: regionGroups.filter((region) =>
        AGENCY_REGION_ORDER.some((entry) => entry.agencyLabel === agencyLabel && entry.branch === region.branch),
      ),
    }))
    .filter((agency) => agency.regions.length > 0)
}
