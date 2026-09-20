/** Shared Agency>Region>Generation/Unit subgrouping algorithm, generic over
 * any creator shape that carries `groupKey`/`channelType` -- used by
 * Notification Settings (the real 112-entry creators.json roster,
 * `creatorId` space), Oshi Settings, and Live Status's own creator list
 * (the latter two both read mockCreators, `channelId` space) so all three
 * group Hololive JP/EN/ID identically without a second/third parallel copy
 * of this same business logic (numbered-generation ordering, the Gamers
 * dual-bucket rule, FLOWGLOW/ReGLOSS group-channel-first ordering,
 * Hololive EN's fixed unit order). Each consumer still keeps its own data
 * source, IDs, and display-name overrides -- only this grouping shape is
 * shared. */

import type { BranchKey } from "../model/domain"

export interface GroupableCreator {
  groupKey: string[]
  channelType: "member" | "group" | "staff"
}

export interface Subgroup<T> {
  /** null for a branch with no generation/unit subdivision (VSPO JP/EN) --
   * rendered with no subgroup header. */
  label: string | null
  creators: T[]
}

/** Sentinel subgroup label for the catch-all "Other" bucket (see
 * groupHololiveJp below) -- never rendered directly; the caller looks up
 * this exact string and renders its own translated "Other" label in its
 * place, so the label reads correctly in whichever locale is active
 * instead of one fixed spelling. */
export const OTHER_GROUP_LABEL_KEY = "__other__"

/** Sentinel subgroup label for the Gamers unit (see groupHololiveJp below)
 * -- never rendered directly; the caller looks up this exact string and
 * renders its own translated "Gamers" label in its place (confirmed
 * wording: "Gamers" in both zh-TW and English, "ゲーマーズ" in Japanese --
 * not a plain pass-through of one fixed spelling like Myth/Promise/
 * ReGLOSS/FLOW GLOW below). */
export const GAMERS_GROUP_LABEL_KEY = "__gamers__"

const NUMBERED_GENERATION_PATTERN = /^(\d+)期生$/

function primaryGroupKey<T extends GroupableCreator>(creator: T): string {
  return creator.groupKey[0] ?? ""
}

/** A unit's own official channel entry (channelType "group", e.g.
 * "hololive ReGLOSS") sorted before its individual members -- confirmed
 * ordering for ReGLOSS/FLOW GLOW below -- members otherwise keep the
 * roster's own existing order. */
function groupChannelFirst<T extends GroupableCreator>(creators: T[]): T[] {
  return [...creators].sort((a, b) => (a.channelType === "group" ? -1 : 0) - (b.channelType === "group" ? -1 : 0))
}

/** hololive JP's own real groupKey values include "ReGLOSS" and "FLOWGLOW"
 * (no literal "Dev_IS" tag exists in the real roster) -- two separate named
 * sections (FLOW GLOW, then ReGLOSS), each its own unit channel first
 * followed by its members, not one combined "Dev_IS" section. Gamers
 * membership is checked against a creator's FULL groupKey array, not just
 * their primary tag -- a creator whose primary tag is a numbered generation
 * (e.g. Shirakami Fubuki, primary "1期生") but who also carries the Gamers
 * tag second still shows under both her own generation AND Gamers, rather
 * than Gamers requiring a creator's primary tag to be Gamers. Anything else
 * unrecognized (e.g. a staff channel's own tag) falls into a catch-all
 * "Other" bucket (OTHER_GROUP_LABEL_KEY) rather than being silently
 * dropped. `getSortName` picks each creator's own display text, used only
 * to sort the "Other" bucket alphabetically. */
export function groupHololiveJp<T extends GroupableCreator>(creators: T[], getSortName: (creator: T) => string): Subgroup<T>[] {
  const numbered = new Map<number, T[]>()
  const gamers: T[] = []
  const flowGlow: T[] = []
  const reGloss: T[] = []
  const other: T[] = []

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

  const subgroups: Subgroup<T>[] = [...numbered.entries()]
    .sort(([a], [b]) => a - b)
    .map(([gen, members]) => ({ label: `${gen}期生`, creators: members }))

  if (gamers.length > 0) subgroups.push({ label: GAMERS_GROUP_LABEL_KEY, creators: gamers })
  if (flowGlow.length > 0) subgroups.push({ label: "FLOW GLOW", creators: groupChannelFirst(flowGlow) })
  if (reGloss.length > 0) subgroups.push({ label: "ReGLOSS", creators: groupChannelFirst(reGloss) })
  if (other.length > 0) {
    const sortedOther = [...other].sort((a, b) => getSortName(a).toLowerCase().localeCompare(getSortName(b).toLowerCase()))
    subgroups.push({ label: OTHER_GROUP_LABEL_KEY, creators: sortedOther })
  }
  return subgroups
}

/** hololive EN's real groupKey values (Myth/Promise/Advent/Justice, in
 * debut order) -- FUWAMOCO carries ["Advent", "FUWAMOCO"], so its primary
 * key already buckets it under Advent correctly. Any future/unrecognized
 * group name is appended at the end rather than dropped. */
export const HOLOLIVE_EN_FIXED_ORDER = ["Myth", "Promise", "Advent", "Justice"]

/** Shared numbered-generation grouping. Labels are the real groupKey
 * values as-is by default (e.g. hololive ID's own "1期生"/"2期生"/"3期生")
 * -- formatLabel exists only for branches that need a display-only
 * transform. */
export function groupByFixedOrThenNumbered<T extends GroupableCreator>(
  creators: T[],
  fixedOrder: string[],
  formatLabel: (key: string) => string = (key) => key,
): Subgroup<T>[] {
  const byKey = new Map<string, T[]>()
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

/** No generation/unit distinction in the real roster (groupKey is always a
 * placeholder like "NO") -- a single, unlabeled subgroup. */
export function groupFlat<T>(creators: T[]): Subgroup<T>[] {
  return creators.length > 0 ? [{ label: null, creators }] : []
}

/** Per-branch dispatch to the right grouping function above -- shared by
 * every consumer that groups a branch's creators into generations/units
 * (Notification Settings, Oshi Settings, and Live Status's own creator
 * list) so this same branch->algorithm mapping isn't copied a third time.
 * `getSortName` is only consulted by holo_jp's "Other" catch-all bucket
 * (see groupHololiveJp above). */
export function subgroupsForBranch<T extends GroupableCreator>(
  branch: BranchKey,
  creators: T[],
  getSortName: (creator: T) => string,
): Subgroup<T>[] {
  switch (branch) {
    case "holo_jp":
      return groupHololiveJp(creators, getSortName)
    case "holo_en":
      return groupByFixedOrThenNumbered(creators, HOLOLIVE_EN_FIXED_ORDER)
    case "holo_id":
      return groupByFixedOrThenNumbered(creators, [])
    case "vspo_jp":
    case "vspo_en":
      return groupFlat(creators)
  }
}
