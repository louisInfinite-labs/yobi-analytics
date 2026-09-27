import type { BranchKey, ChannelType, GroupKey, LifecycleStage, OrganizationKey } from "./domain"

/** One creator record from the generated Creator Registry (entities/creator/
 * data/generated/creatorMaster.json), itself generated from the backend
 * canonical Creator Master (scripts/codegen/generate_creator_registry.py) --
 * see creatorRegistry.ts for the loader. Stable canonical facts only: no
 * runtime field (live status, stream title, scheduled/actual time, current
 * topic, Holodex data) belongs here -- those come from a runtime API, never
 * this static, build-time artifact. */
export interface CanonicalCreator {
  creatorId: string
  displayName: string
  avatarUrl: string | null
  organization: OrganizationKey
  branch: BranchKey
  groupKey: GroupKey[]
  channelType: ChannelType
  themeColor: string | null
  lifecycleStage: LifecycleStage
  active: boolean
  youtubeChannelId: string
}

/** The generated artifact's own top-level shape -- legacyAliases is the
 * SAME table backend's tracking.creator_master.LEGACY_CREATOR_ID_ALIASES
 * generates from (scripts/codegen/generate_creator_registry.py); this type
 * exists so creatorRegistry.ts never has to hand-copy those entries into
 * TypeScript. */
export interface CreatorMasterRegistryFile {
  creators: CanonicalCreator[]
  legacyAliases: Record<string, string>
}
