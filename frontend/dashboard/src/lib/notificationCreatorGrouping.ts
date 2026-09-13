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

const ALL_CREATORS = rawCreators as NotificationCreator[]

/** Branch display order -- matches lib/dockCreatorOrder.ts's own
 * DOCK_BRANCH_ORDER (VSPO JP, VSPO EN, hololive JP/EN/ID), this feature's
 * own spec order. Not imported from there directly to keep this
 * self-contained: that file's internals are private and tuned for the
 * Dock's own flat (non-subgrouped) creator list, not this page's nested
 * branch > generation display. */
const BRANCH_ORDER: BranchKey[] = ["vspo_jp", "vspo_en", "holo_jp", "holo_en", "holo_id"]

export interface CreatorSubgroup {
  /** null for a branch with no generation/unit subdivision (VSPO JP/EN,
   * per this feature's own spec) -- rendered with no subgroup header. */
  label: string | null
  creators: NotificationCreator[]
}

export interface CreatorBranchGroup {
  branch: BranchKey
  subgroups: CreatorSubgroup[]
}

function primaryGroupKey(creator: NotificationCreator): string {
  return creator.groupKey[0] ?? ""
}

const NUMBERED_GENERATION_PATTERN = /^(\d+)期生$/

/** hololive JP's own real groupKey values include "ReGLOSS" and "FLOWGLOW"
 * (no literal "Dev_IS" tag exists in the roster) -- both are hololive's
 * actual DEV_IS-brand units, combined into one "Dev_IS" section per this
 * feature's own spec ("Dev_IS" as a single named group, not two). Anything
 * else unrecognized (e.g. a staff channel's own tag) falls into a catch-all
 * "Other" bucket rather than being silently dropped. */
function groupHololiveJp(creators: NotificationCreator[]): CreatorSubgroup[] {
  const numbered = new Map<number, NotificationCreator[]>()
  const gamers: NotificationCreator[] = []
  const devIs: NotificationCreator[] = []
  const other: NotificationCreator[] = []

  for (const creator of creators) {
    const key = primaryGroupKey(creator)
    const numberedMatch = key.match(NUMBERED_GENERATION_PATTERN)
    if (numberedMatch) {
      const gen = Number(numberedMatch[1])
      const bucket = numbered.get(gen)
      if (bucket) bucket.push(creator)
      else numbered.set(gen, [creator])
    } else if (key === "ゲーマーズ") {
      gamers.push(creator)
    } else if (key === "ReGLOSS" || key === "FLOWGLOW") {
      devIs.push(creator)
    } else {
      other.push(creator)
    }
  }

  const subgroups: CreatorSubgroup[] = [...numbered.entries()]
    .sort(([a], [b]) => a - b)
    .map(([gen, members]) => ({ label: `${gen}期生`, creators: members }))

  if (gamers.length > 0) subgroups.push({ label: "ゲーマーズ", creators: gamers })
  if (devIs.length > 0) subgroups.push({ label: "Dev_IS", creators: devIs })
  if (other.length > 0) subgroups.push({ label: "その他", creators: other })
  return subgroups
}

/** hololive EN's real groupKey values (Myth/Promise/Advent/Justice, in
 * debut order) -- FUWAMOCO carries ["Advent", "FUWAMOCO"], so its primary
 * key already buckets it under Advent correctly. Any future/unrecognized
 * group name is appended at the end rather than dropped. */
const HOLOLIVE_EN_FIXED_ORDER = ["Myth", "Promise", "Advent", "Justice"]

/** hololive ID's real groupKey values are plain numbered generations
 * only (generations 1 through 3 as of this roster) -- same numbering rule as JP, no
 * fixed-name tail needed. */
function groupByFixedOrThenNumbered(creators: NotificationCreator[], fixedOrder: string[]): CreatorSubgroup[] {
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

  return [...numberedKeys, ...fixedKeys, ...leftoverKeys].map((key) => ({ label: key, creators: byKey.get(key)! }))
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

/** Every creator in the roster, grouped into this feature's own fixed
 * branch order, then each branch's own generation/unit subgroups (see
 * subgroupsForBranch) -- the full [Branch][Generation][Creators] tree
 * NotificationSettings renders. */
export function groupCreatorsForNotificationSettings(): CreatorBranchGroup[] {
  return BRANCH_ORDER.map((branch) => ({
    branch,
    subgroups: subgroupsForBranch(
      branch,
      ALL_CREATORS.filter((creator) => creator.branch === branch),
    ),
  })).filter((group) => group.subgroups.length > 0)
}
