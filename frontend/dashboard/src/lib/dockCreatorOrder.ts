import type { MockCreator } from "../data/mockCreators"
import { normalizeJapaneseReadingForSort } from "./japaneseReading"
import type { BranchKey } from "../types/domain"

/** Spec's required Dock grouping/order: VSPO JP, VSPO EN, hololive JP, EN,
 * ID (each internally in generation order). BranchKey's five values map
 * exactly onto this list. */
export const DOCK_BRANCH_ORDER: BranchKey[] = ["vspo_jp", "vspo_en", "holo_jp", "holo_en", "holo_id"]

/** A creator can carry more than one groupKey (e.g. 白上フブキ: ["1期生",
 * "ゲーマーズ"]) — the first tag is treated as the primary generation/unit for
 * grouping purposes, matching how the array itself already puts a creator's
 * "main" tag first. */
function primaryGroupKey(creator: MockCreator): string {
  return creator.groupKey[0] ?? ""
}

function sortAlphabetical(creators: MockCreator[]): MockCreator[] {
  return [...creators].sort((a, b) => a.channelName.toLowerCase().localeCompare(b.channelName.toLowerCase()))
}

/** Japanese gojuon comparator: Hiragana and Katakana readings compare as ONE
 * combined phonetic order (via normalizeJapaneseReadingForSort), not two
 * separate script blocks. A creator missing `kana` never crashes and is
 * never guessed from its Kanji display name — it sorts after every creator
 * that does have a reading, and ties (including two missing-kana creators)
 * keep mockCreators' own declared relative order via Array.sort's stability. */
function compareByNormalizedKana(a: MockCreator, b: MockCreator): number {
  if (!a.kana && !b.kana) return 0
  if (!a.kana) return 1
  if (!b.kana) return -1
  return normalizeJapaneseReadingForSort(a.kana).localeCompare(normalizeJapaneseReadingForSort(b.kana), "ja")
}

const NUMBERED_GENERATION_PATTERN = /^(\d+)期生$/

/** Non-numbered Hololive JP units, in the exact order confirmed this
 * session (2026-09-11) — everything else (e.g. a staff channel's "NO" tag,
 * or any future unrecognized groupKey) sorts after all of these and keeps
 * mockCreators' own relative order, since its exact placement was not part
 * of that confirmation. */
const HOLOLIVE_JP_FIXED_GROUP_ORDER = ["ゲーマーズ", "holoX", "DEV_IS", "ReGLOSS", "FLOW GLOW"]

/** Numbered generations (any N期生) sort first, ascending; then the fixed
 * non-numbered units above; anything unrecognized sorts last of all. */
function hololiveJpGroupRank(groupKey: string): number {
  const numbered = groupKey.match(NUMBERED_GENERATION_PATTERN)
  if (numbered) return Number(numbered[1])
  const fixedIndex = HOLOLIVE_JP_FIXED_GROUP_ORDER.indexOf(groupKey)
  if (fixedIndex !== -1) return 1000 + fixedIndex
  return Number.POSITIVE_INFINITY
}

/** Hololive JP: level 1 is the existing, unchanged generation/unit rank
 * (numbered generations ascending, then ゲーマーズ/holoX/DEV_IS/ReGLOSS/FLOW
 * GLOW, then anything else) — a creator's kana can never move it into a
 * different generation/unit. Level 2, inside the SAME rank, is the
 * normalized Japanese-gojuon comparator; ties there (equal readings, or
 * missing kana) keep mockCreators' own declared order via Array.sort's
 * stability. */
function sortHololiveJp(creators: MockCreator[]): MockCreator[] {
  return [...creators].sort((a, b) => {
    const rankDiff = hololiveJpGroupRank(primaryGroupKey(a)) - hololiveJpGroupRank(primaryGroupKey(b))
    return rankDiff !== 0 ? rankDiff : compareByNormalizedKana(a, b)
  })
}

/** Hololive EN/ID (spec 3D): group by primary groupKey, sort the groups
 * themselves A-Z by group name, then sort members A-Z by display name
 * within each group. No kana dependency — both are Latin-alphabet sorts. */
function sortHololiveEnOrId(creators: MockCreator[]): MockCreator[] {
  const byGroup = new Map<string, MockCreator[]>()
  for (const creator of creators) {
    const key = primaryGroupKey(creator)
    const members = byGroup.get(key)
    if (members) members.push(creator)
    else byGroup.set(key, [creator])
  }
  const groupNamesAz = [...byGroup.keys()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  return groupNamesAz.flatMap((groupName) => sortAlphabetical(byGroup.get(groupName)!))
}

/** VSPO JP: full Japanese gojuon sort by `kana` (no generation/unit
 * grouping is required for this branch — spec 3A). A creator missing
 * `kana` falls back to stable roster order rather than being guessed. */
function sortVspoJp(creators: MockCreator[]): MockCreator[] {
  return [...creators].sort(compareByNormalizedKana)
}

/** Per-branch stable ordering (spec section 5 / this session's "STABLE
 * CREATOR SORTING" follow-up) — never a function of live/upcoming/offline
 * status, only of the creator's own branch/groupKey/name/kana. */
function sortWithinBranch(branch: BranchKey, creators: MockCreator[]): MockCreator[] {
  switch (branch) {
    case "vspo_jp":
      return sortVspoJp(creators)
    case "vspo_en":
      return sortAlphabetical(creators)
    case "holo_jp":
      return sortHololiveJp(creators)
    case "holo_en":
    case "holo_id":
      return sortHololiveEnOrId(creators)
    default:
      return creators
  }
}

/** Groups creators into the spec's fixed branch order, then applies each
 * branch's own stable sort (sortWithinBranch) — never one inferred from
 * live status (spec: "follow the app's explicit creator config order...
 * unless no configured order exists"). */
export function groupCreatorsForDock(creators: MockCreator[]): { branch: BranchKey; creators: MockCreator[] }[] {
  return DOCK_BRANCH_ORDER.map((branch) => ({
    branch,
    creators: sortWithinBranch(
      branch,
      creators.filter((creator) => creator.branch === branch),
    ),
  })).filter((group) => group.creators.length > 0)
}

/** Case-insensitive match against the creator's display name. No separate
 * English/romanized alias list exists in this app's creator data yet — see
 * this session's own scoping note — so this matches whatever channelName
 * already holds (already English for some creators, e.g. "Gawr Gura").
 * The row itself always displays the Japanese/channel name regardless of
 * what matched (spec: "the row still displays the Japanese name"). */
export function creatorMatchesSearch(creator: MockCreator, query: string): boolean {
  if (query.trim() === "") return true
  return creator.channelName.toLowerCase().includes(query.trim().toLowerCase())
}
