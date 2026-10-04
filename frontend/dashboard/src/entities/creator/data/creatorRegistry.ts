import creatorMasterFile from "./generated/creatorMaster.json"
import type { CanonicalCreator, CreatorMasterRegistryFile } from "../model/creatorMaster"

/** The single frontend access layer for the generated Creator Registry
 * (entities/creator/data/generated/creatorMaster.json, C3). No feature
 * should import that JSON file directly -- every consumer goes through the
 * functions below, so the generated file's own shape can change without
 * every importer needing to change with it. */
const registry = creatorMasterFile as CreatorMasterRegistryFile

/** Legacy frontend roster ids are "ch_" + creatorId (e.g. "ch_aizawa_ema" for
 * creatorId "aizawa_ema") -- same convention backendComparisonSource.ts and
 * creatorFavoriteBridge.ts already document and rely on, and the same
 * convention tracking.creator_master.resolve_creator_key() implements on
 * the backend (C2). This mirrors that function's exact logic, sourced from
 * the SAME generated legacyAliases table -- never a hand-copied second
 * table. */
const LEGACY_ROSTER_ID_PREFIX = "ch_"

const creatorsById = new Map<string, CanonicalCreator>()
const creatorsByYoutubeChannelId = new Map<string, CanonicalCreator>()

for (const creator of registry.creators) {
  creatorsById.set(creator.creatorId, creator)

  // Built once at module load, matching creatorsById above -- fails loudly
  // (rather than silently picking one) the moment this module is ever
  // imported if the generated data is inconsistent, the same invariant
  // backend's find_creator_by_youtube_channel_id() enforces (C2). The
  // current real registry is already verified duplicate-free by that
  // backend test, so this should never actually throw.
  if (creatorsByYoutubeChannelId.has(creator.youtubeChannelId)) {
    const existing = creatorsByYoutubeChannelId.get(creator.youtubeChannelId)!
    throw new Error(
      `Duplicate youtubeChannelId ${creator.youtubeChannelId} in generated Creator Registry: ` +
        `${existing.creatorId} and ${creator.creatorId}`,
    )
  }
  creatorsByYoutubeChannelId.set(creator.youtubeChannelId, creator)
}

/** Every creator in the generated registry, in its own (creatorId-sorted)
 * order -- a read-only view, never mutated by any consumer. */
export function getCreators(): readonly CanonicalCreator[] {
  return registry.creators
}

/** Look up a creator by its canonical backend creatorId only -- no "ch_"
 * stripping or alias resolution (see resolveCreatorKey for that). */
export function getCreatorById(creatorId: string): CanonicalCreator | undefined {
  return creatorsById.get(creatorId)
}

/** Resolve a canonical creatorId, legacy "ch_"-prefixed frontend id, or known
 * legacy alias (registry.legacyAliases) to its Creator Registry record --
 * the frontend counterpart of tracking.creator_master.resolve_creator_key()
 * (C2). Stripping "ch_" (or applying an alias) only produces a *candidate*
 * id -- the lookup against the registry is what decides success, so a
 * mock/legacy-only id with no real counterpart (e.g. "ch_hololive_staff" ->
 * candidate "hololive_staff") resolves to undefined rather than a
 * fabricated record. Returns undefined (never throws) for blank input, an
 * unrecognized canonical id, or an unrecognized "ch_" id. */
export function resolveCreatorKey(key: string): CanonicalCreator | undefined {
  if (typeof key !== "string" || !key.trim()) return undefined

  const isAlias = Object.prototype.hasOwnProperty.call(registry.legacyAliases, key)
  let candidate = isAlias ? registry.legacyAliases[key] : key
  if (!isAlias && candidate.startsWith(LEGACY_ROSTER_ID_PREFIX)) {
    candidate = candidate.slice(LEGACY_ROSTER_ID_PREFIX.length)
  }
  return creatorsById.get(candidate)
}

/** The legacy "ch_"-prefixed frontend id for a canonical creator -- the exact
 * inverse of resolveCreatorKey's own alias/prefix logic (registry.legacyAliases
 * reversed, else "ch_" + creatorId). Needed only by code that still writes
 * into a storage format or comparison shared with a not-yet-migrated
 * consumer still reading mockCreators.channelId directly (e.g. My Oshi's
 * persisted pick, also read by Live Status's CreatorStatusList and Home's
 * useSelectedCreator) -- an ordinary canonical-registry consumer should
 * never need this. */
export function toLegacyRosterId(creator: CanonicalCreator): string {
  const aliasEntry = Object.entries(registry.legacyAliases).find(([, canonicalId]) => canonicalId === creator.creatorId)
  return aliasEntry ? aliasEntry[0] : `${LEGACY_ROSTER_ID_PREFIX}${creator.creatorId}`
}

/** Look up a creator by its real YouTube/Holodex channel id -- distinct from
 * resolveCreatorKey above, which resolves this app's own legacy id forms.
 * Uses the same generated canonical registry as every other lookup here,
 * never a separate hand-maintained table (the frontend Holodex integration's
 * own former hand-picked creatorId->channelId map was retired in C6 in favor
 * of this registry). This is what future Holodex work (H4/H7) needs to map a
 * Holodex youtube_channel_id back to a creator. */
export function getCreatorByYoutubeChannelId(youtubeChannelId: string): CanonicalCreator | undefined {
  if (typeof youtubeChannelId !== "string" || !youtubeChannelId.trim()) return undefined
  return creatorsByYoutubeChannelId.get(youtubeChannelId)
}

/** A CURRENT individual talent: under active collection, an individual
 * member channel, and active or pre_debut. This is deliberately the NARROW
 * rule -- used for "who is a current member" surfaces (Notification Settings,
 * and the fallback default Oshi). It is NOT the Live Status roster rule and
 * NOT the My Oshi selection rule; see isLiveStatusDisplayEligible and
 * isMyOshiEligible below, which differ on purpose. Derived from stable
 * canonical facts (active/channelType/lifecycleStage) every time this is
 * called -- never a stored boolean, so there is nothing here that can drift
 * from the backend rule the way a precomputed flag could. */
export function isCurrentMemberEligible(creator: CanonicalCreator): boolean {
  return (
    creator.active &&
    creator.channelType === "member" &&
    (creator.lifecycleStage === "active" || creator.lifecycleStage === "pre_debut")
  )
}

/** Whether a channel gets a row in Live Status: every supported channel in the
 * canonical roster -- members (including graduated), group and staff channels --
 * regardless of lifecycle, channel type, or any video/ranking/manifest data. A
 * channel with no stream data renders OFFLINE; it is never removed. Mirrors the
 * backend's is_live_status_display_eligible. */
export function isLiveStatusDisplayEligible(creator: CanonicalCreator): boolean {
  return creator.active
}

/** Whether a user may pick this channel as their Oshi: an individual creator
 * (channelType "member") in any lifecycle stage a person can be selected in --
 * including graduated, because graduation stops new-content collection but does
 * not remove the creator or invalidate an existing selection. Group and staff
 * channels are never an Oshi. Mirrors the backend's is_my_oshi_eligible. */
export function isMyOshiEligible(creator: CanonicalCreator): boolean {
  return (
    creator.active &&
    creator.channelType === "member" &&
    (creator.lifecycleStage === "active" ||
      creator.lifecycleStage === "pre_debut" ||
      creator.lifecycleStage === "graduated")
  )
}
