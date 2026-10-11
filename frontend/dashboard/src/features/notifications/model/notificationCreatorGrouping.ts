import { getCreators, isCurrentMemberEligible } from "../../../entities/creator/data/creatorRegistry"
import { GAMERS_GROUP_LABEL_KEY, OTHER_GROUP_LABEL_KEY } from "../../../entities/creator/utils/hololiveSubgrouping"
import { groupEligibleCreatorsForLiveStatus } from "../../live-status/utils/liveStatusCanonicalRoster"
import type { BranchKey } from "../../../entities/creator/model/domain"
import type { CanonicalCreator } from "../../../entities/creator/model/creatorMaster"

export { GAMERS_GROUP_LABEL_KEY, OTHER_GROUP_LABEL_KEY }

/** The canonical Creator Registry (entities/creator/data/creatorRegistry,
 * generated from backend Creator Master -- C5A/C5B), not the small ~13-entry
 * frontend mockCreators.ts used elsewhere for Home/Dock demos. Previously
 * this feature kept its own bundled static copy of the real roster
 * (features/notifications/data/creators.json), which silently drifted from
 * the live backend (discovered stale at 112 entries vs. the real 118) --
 * that file is gone; this type/roster is sourced live from the shared
 * registry instead, so it can never drift the same way again.
 *
 * A creator only appears in ALL_CREATORS below if isCurrentMemberEligible
 * (C4's canonical rule) says so -- a graduated/retired member, a group, or
 * a staff channel is deliberately excluded now, which is an intentional
 * behavior change from the old roster's "show literally everyone" default. */
export interface NotificationCreator {
  creatorId: string
  displayName: string
  /** The canonical registry's channel icon URL (backend Creator Master `avatarUrl`); null when the creator has none. */
  avatarUrl: string | null
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

/** The smallest mapping from the canonical registry's shape onto this
 * feature's own existing NotificationCreator shape -- discoveryEnabled/
 * graduatedAt are left unset (the generated registry doesn't carry them,
 * and nothing in this feature ever reads either field; see C5B's own
 * investigation). No field here is derived/invented -- every value is a
 * direct canonical fact. */
function toNotificationCreator(creator: CanonicalCreator): NotificationCreator {
  return {
    creatorId: creator.creatorId,
    displayName: creator.displayName,
    avatarUrl: creator.avatarUrl,
    organization: creator.organization,
    youtubeChannelId: creator.youtubeChannelId,
    active: creator.active,
    branch: creator.branch,
    channelType: creator.channelType,
    lifecycleStage: creator.lifecycleStage,
    groupKey: creator.groupKey,
  }
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

// Eligibility (C4/isCurrentMemberEligible) is applied before the display-name
// override and before anything downstream ever sees these records -- a
// graduated/retired member, a group, or a staff channel simply never enters
// ALL_CREATORS, the same way every consumer of it (grouping, search,
// Favorites) already expects a flat "the roster" list to behave.
const ALL_CREATORS = getCreators()
  .filter(isCurrentMemberEligible)
  .map(toNotificationCreator)
  .map(withDisplayNameOverride)

/** The same real Creator Master roster ALL_CREATORS above already loads,
 * exposed flat (not grouped) -- for consumers that need to resolve a
 * creatorId to its creator record (e.g. the topic Notification Settings'
 * compact "already selected" name preview) or filter/partition the whole
 * roster themselves (e.g. TopicCreatorManagementDrawer's own Favorites vs.
 * agency-group split) rather than walking the grouped tree. */
export function getAllNotificationCreators(): NotificationCreator[] {
  return ALL_CREATORS
}

export interface CreatorSubgroup {
  /** null for a branch with no generation/unit subdivision (VSPO JP/EN) -- rendered with no subgroup header. */
  label: string | null
  creators: NotificationCreator[]
}

/** One Live Status branch group ("VSPO! // JP", "HOLOLIVE // EN", ...) of this roster. */
export interface NotificationBranchGroup {
  branch: BranchKey
  subgroups: CreatorSubgroup[]
}

const NOTIFICATION_CREATOR_BY_ID = new Map(ALL_CREATORS.map((creator) => [creator.creatorId, creator]))

/** Every creator in the roster, grouped EXACTLY as Live Status groups them: this is groupEligibleCreatorsForLiveStatus itself (the same
 * branch order, the same generation/unit subgroups, the same member order, the same "VSPO! // JP" headings via LiveStatusGroups), narrowed
 * to the creators this feature lists (isCurrentMemberEligible) and mapped to this feature's NotificationCreator records. There is no
 * second grouping, ordering or labelling rule here -- not an agency/region tree, not a kana or alphabetical sort, not the Favorites list. */
export function groupCreatorsForNotificationSettings(): NotificationBranchGroup[] {
  return groupEligibleCreatorsForLiveStatus("", isCurrentMemberEligible).map((group) => ({
    branch: group.branch,
    subgroups: group.subgroups.map((subgroup) => ({
      label: subgroup.label,
      creators: subgroup.creators.flatMap((creator) => NOTIFICATION_CREATOR_BY_ID.get(creator.creatorId) ?? []),
    })),
  }))
}

/** `creators` reordered to Live Status' own order (the first place each appears in groupCreatorsForNotificationSettings) -- for the flat
 * Favorites section, so it never invents a second ordering. */
export function sortCreatorsLikeLiveStatus(creators: NotificationCreator[]): NotificationCreator[] {
  const position = new Map<string, number>()
  for (const group of groupCreatorsForNotificationSettings()) {
    for (const subgroup of group.subgroups) {
      for (const creator of subgroup.creators) if (!position.has(creator.creatorId)) position.set(creator.creatorId, position.size)
    }
  }
  return [...creators].sort((a, b) => (position.get(a.creatorId) ?? Infinity) - (position.get(b.creatorId) ?? Infinity))
}
