import type { MockCreator } from "../data/mockCreators"
import type { BranchKey } from "../types/domain"

/** Spec's required Dock grouping/order: VSPO JP, VSPO EN, hololive JP, EN,
 * ID (each internally in generation order). BranchKey's five values map
 * exactly onto this list. */
export const DOCK_BRANCH_ORDER: BranchKey[] = ["vspo_jp", "vspo_en", "holo_jp", "holo_en", "holo_id"]

/** Groups creators into the spec's fixed branch order. Within a branch,
 * preserves mockCreators's own array order rather than inferring one from
 * live status or alphabetizing (spec: "follow the app's explicit creator
 * config order... unless no configured order exists") — that array *is*
 * this app's creator config, so its order is the source of truth here. */
export function groupCreatorsForDock(creators: MockCreator[]): { branch: BranchKey; creators: MockCreator[] }[] {
  return DOCK_BRANCH_ORDER.map((branch) => ({
    branch,
    creators: creators.filter((creator) => creator.branch === branch),
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
