import { getCreators, isCurrentMemberEligible, isMyOshiEligible, resolveCreatorKey, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import type { CanonicalCreator } from "../../../entities/creator/model/creatorMaster"
import { createSharedState, useSharedState } from "../../../shared/state/sharedState"

const STORAGE_KEY = "yobi.defaultOshiCreatorId"

/** The CURRENT members, ascending by displayOrder (C8A0) -- the pool the
 * fallback default is drawn from, so a fresh install never defaults to a
 * graduated creator even though graduated creators are selectable. Never
 * getCreators()'s own raw array order, which stays alphabetical-by-creatorId
 * for deterministic codegen and is not a display order. */
function selectableCreatorsByDisplayOrder(): CanonicalCreator[] {
  return getCreators()
    .filter(isCurrentMemberEligible)
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder)
}

/** The first creator in the normally ordered selectable roster -- not a
 * hardcoded id. Production data currently makes this aizawa_ema because she
 * is first by canonical displayOrder, not because she is special-cased. */
function fallbackCreatorId(): string {
  const [first] = selectableCreatorsByDisplayOrder()
  return toLegacyRosterId(first)
}

/** Exported (not just used internally) so useSelectedCreator.ts can seed its
 * own in-session value from this same persisted pick at its own module
 * load -- see that file's own comment. Returns the legacy "ch_"-prefixed
 * roster id (never a bare canonical creatorId) so this value stays readable
 * by not-yet-migrated consumers still comparing against mockCreators.channelId
 * (e.g. CreatorStatusList's own MAIN badge) -- the persisted format itself is
 * unchanged by this migration, only where the identity/eligibility data
 * comes from. */
export function readDefaultOshiCreatorId(): string {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const resolved = resolveCreatorKey(raw)
      // isMyOshiEligible, not the current-member rule: a creator who has since graduated stays a valid saved Oshi.
      if (resolved && isMyOshiEligible(resolved)) return toLegacyRosterId(resolved)
    }
  } catch {
    // Fall through to the default below.
  }
  return fallbackCreatorId()
}

// Module-scoped singleton (see lib/sharedState.ts).
const defaultOshiStore = createSharedState(STORAGE_KEY, readDefaultOshiCreatorId, (value) => value)

/** Settings > 我推設定's own persistent single-Oshi pick -- confirmed with
 * the user, this is "defaultOshi": the creator Home shows on a fresh app
 * startup, kept entirely separate from useSelectedCreator's own
 * "currentOshi" (the creator the user happens to be viewing THIS session,
 * which changes freely while navigating around the app). Only picking a
 * creator on the 我推設定 page itself ever updates this store -- switching
 * creator anywhere else in the app never touches it. */
export function useDefaultOshiCreator() {
  return useSharedState(defaultOshiStore)
}
