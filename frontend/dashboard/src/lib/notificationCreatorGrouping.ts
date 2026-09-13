import rawCreators from "../data/creators.json"
import type { BranchKey } from "../types/domain"

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

function primaryGroupKey(creator: NotificationCreator): string {
  return creator.groupKey[0] ?? ""
}

/** Sentinel subgroup label for the catch-all "Other" bucket (see
 * groupHololiveJp below) -- never rendered directly; the caller looks up
 * this exact string and renders `t(locale, "notificationSettings.
 * otherGroupLabel")` in its place, so the label reads correctly in
 * whichever locale is active instead of one fixed spelling. */
export const OTHER_GROUP_LABEL_KEY = "__other__"

/** Sentinel subgroup label for the Gamers unit (see groupHololiveJp
 * below) -- never rendered directly; the caller looks up this exact
 * string and renders `t(locale, "notificationSettings.gamersGroupLabel")`
 * in its place (confirmed wording: "Gamers" in both zh-TW and English,
 * "ゲーマーズ" in Japanese -- not a plain pass-through of one fixed
 * spelling like Myth/Promise/ReGLOSS/FLOW GLOW below). */
export const GAMERS_GROUP_LABEL_KEY = "__gamers__"

const NUMBERED_GENERATION_PATTERN = /^(\d+)期生$/

/** A unit's own official channel entry (channelType "group", e.g.
 * "hololive DEV_IS ReGLOSS") sorted before its individual members,
 * confirmed ordering for ReGLOSS/FLOW GLOW below -- members otherwise
 * keep the roster's own existing order. */
function groupChannelFirst(creators: NotificationCreator[]): NotificationCreator[] {
  return [...creators].sort((a, b) => (a.channelType === "group" ? -1 : 0) - (b.channelType === "group" ? -1 : 0))
}

/** hololive JP's own real groupKey values include "ReGLOSS" and "FLOWGLOW"
 * (no literal "Dev_IS" tag exists in the roster) -- confirmed as two
 * separate named sections (FLOW GLOW, then ReGLOSS), each its own unit
 * channel first followed by its members, not one combined "Dev_IS"
 * section. Gamers membership is checked against a creator's FULL groupKey
 * array, not just their primary tag -- confirmed that a creator whose
 * primary tag is a numbered generation (e.g. Shirakami Fubuki, primary
 * "1期生") but who also carries the Gamers tag second still shows under
 * both her own generation AND Gamers, rather than Gamers requiring a
 * creator's primary tag to be Gamers. Anything else unrecognized (e.g. a
 * staff channel's own tag) falls into a catch-all "Other" bucket
 * (OTHER_GROUP_LABEL_KEY, not a display string -- unlike every other
 * label here, "Other" needs its own locale-specific wording rather than
 * one fixed spelling, so the caller renders it through t()) rather than
 * being silently dropped. */
function groupHololiveJp(creators: NotificationCreator[]): CreatorSubgroup[] {
  const numbered = new Map<number, NotificationCreator[]>()
  const gamers: NotificationCreator[] = []
  const flowGlow: NotificationCreator[] = []
  const reGloss: NotificationCreator[] = []
  const other: NotificationCreator[] = []

  for (const creator of creators) {
    const key = primaryGroupKey(creator)
    const numberedMatch = key.match(NUMBERED_GENERATION_PATTERN)
    if (numberedMatch) {
      const gen = Number(numberedMatch[1])
      const bucket = numbered.get(gen)
      if (bucket) bucket.push(creator)
      else numbered.set(gen, [creator])
    } else if (key === "FLOWGLOW") {
      flowGlow.push(creator)
    } else if (key === "ReGLOSS") {
      reGloss.push(creator)
    } else if (key !== "ゲーマーズ") {
      other.push(creator)
    }

    if (creator.groupKey.includes("ゲーマーズ")) gamers.push(creator)
  }

  const subgroups: CreatorSubgroup[] = [...numbered.entries()]
    .sort(([a], [b]) => a - b)
    .map(([gen, members]) => ({ label: `${gen}期生`, creators: members }))

  if (gamers.length > 0) subgroups.push({ label: GAMERS_GROUP_LABEL_KEY, creators: gamers })
  if (flowGlow.length > 0) subgroups.push({ label: "FLOW GLOW", creators: groupChannelFirst(flowGlow) })
  if (reGloss.length > 0) subgroups.push({ label: "ReGLOSS", creators: groupChannelFirst(reGloss) })
  if (other.length > 0) {
    const sortedOther = [...other].sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()))
    subgroups.push({ label: OTHER_GROUP_LABEL_KEY, creators: sortedOther })
  }
  return subgroups
}

/** hololive EN's real groupKey values (Myth/Promise/Advent/Justice, in
 * debut order) -- FUWAMOCO carries ["Advent", "FUWAMOCO"], so its primary
 * key already buckets it under Advent correctly. Any future/unrecognized
 * group name is appended at the end rather than dropped. */
const HOLOLIVE_EN_FIXED_ORDER = ["Myth", "Promise", "Advent", "Justice"]

/** Shared numbered-generation grouping. Labels are the real groupKey
 * values as-is by default (e.g. hololive ID's own "1期生"/"2期生"/"3期生",
 * the same Japanese numbered-generation convention as hololive JP) --
 * formatLabel exists only for branches that need a display-only
 * transform. */
function groupByFixedOrThenNumbered(
  creators: NotificationCreator[],
  fixedOrder: string[],
  formatLabel: (key: string) => string = (key) => key,
): CreatorSubgroup[] {
  const byKey = new Map<string, NotificationCreator[]>()
  for (const creator of creators) {
    const key = primaryGroupKey(creator)
    const bucket = byKey.get(key)
    if (bucket) bucket.push(creator)
    else byKey.set(key, [creator])
  }

  const numberedKeys = [...byKey.keys()]
    .filter((key) => NUMBERED_GENERATION_PATTERN.test(key))
    .sort((a, b) => Number(a.match(NUMBERED_GENERATION_PATTERN)![1]) - Number(b.match(NUMBERED_GENERATION_PATTERN)![1]))
  const fixedKeys = fixedOrder.filter((key) => byKey.has(key))
  const leftoverKeys = [...byKey.keys()].filter((key) => !numberedKeys.includes(key) && !fixedKeys.includes(key))

  return [...numberedKeys, ...fixedKeys, ...leftoverKeys].map((key) => ({
    label: formatLabel(key),
    creators: byKey.get(key)!,
  }))
}

/** VSPO JP/EN carry no generation/unit distinction in the real roster
 * (groupKey is always the placeholder "NO") -- a single, unlabeled
 * subgroup per this feature's own spec. */
function groupFlat(creators: NotificationCreator[]): CreatorSubgroup[] {
  return creators.length > 0 ? [{ label: null, creators }] : []
}

function subgroupsForBranch(branch: BranchKey, creators: NotificationCreator[]): CreatorSubgroup[] {
  switch (branch) {
    case "holo_jp":
      return groupHololiveJp(creators)
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
