import type { BranchKey, ChannelType, ContentFormat, ContentTagKey, GroupKey, LifecycleStage, OrganizationKey } from "../types/domain"
import type { MockCreator } from "../data/mockCreators"

export interface FilterState {
  organization: OrganizationKey | null
  branch: BranchKey | null
  groupKey: GroupKey[]
  channelType: ChannelType | null
  lifecycleStage: LifecycleStage | null
  contentTags: ContentTagKey[]
  contentFormat: ContentFormat | null
}

export const EMPTY_FILTER_STATE: FilterState = {
  organization: null,
  branch: null,
  groupKey: [],
  channelType: null,
  lifecycleStage: null,
  contentTags: [],
  contentFormat: null,
}

/** Organization -> Branch -> GroupKey is a true nested hierarchy (dashboard_ui_direction_en.md
 * section 6): changing a parent must clear any child selection that is no longer valid under it,
 * while leaving still-valid selections untouched. channelType/lifecycleStage/contentTags/
 * contentFormat are independent cross-cutting filters, not children of this chain. */
export function setOrganization(state: FilterState, organization: OrganizationKey | null, creators: MockCreator[]): FilterState {
  if (organization === state.organization) return state
  const validBranches = new Set(
    creators.filter((c) => organization === null || c.organization === organization).map((c) => c.branch),
  )
  const branch = state.branch && validBranches.has(state.branch) ? state.branch : null
  const groupKey = filterValidGroupKeys(state.groupKey, organization, branch, creators)
  return { ...state, organization, branch, groupKey }
}

export function setBranch(state: FilterState, branch: BranchKey | null, creators: MockCreator[]): FilterState {
  if (branch === state.branch) return state
  // Defensive, mirroring setOrganization: the UI only ever offers branches
  // already scoped to state.organization (BranchFilter's own `options`
  // prop), but this function is exported standalone, so a caller passing a
  // branch that doesn't belong to the current organization must not be
  // allowed to produce an inconsistent (organization, branch) pair.
  const validBranches = new Set(
    creators.filter((c) => state.organization === null || c.organization === state.organization).map((c) => c.branch),
  )
  const validBranch = branch !== null && validBranches.has(branch) ? branch : null
  const groupKey = filterValidGroupKeys(state.groupKey, state.organization, validBranch, creators)
  return { ...state, branch: validBranch, groupKey }
}

function filterValidGroupKeys(
  selected: GroupKey[],
  organization: OrganizationKey | null,
  branch: BranchKey | null,
  creators: MockCreator[],
): GroupKey[] {
  const scoped = creators.filter(
    (c) => (organization === null || c.organization === organization) && (branch === null || c.branch === branch),
  )
  const valid = new Set(scoped.flatMap((c) => c.groupKey))
  return selected.filter((key) => valid.has(key))
}

export function toggleGroupKey(state: FilterState, key: GroupKey): FilterState {
  const has = state.groupKey.includes(key)
  return { ...state, groupKey: has ? state.groupKey.filter((k) => k !== key) : [...state.groupKey, key] }
}

export function toggleContentTag(state: FilterState, tag: ContentTagKey): FilterState {
  const has = state.contentTags.includes(tag)
  return { ...state, contentTags: has ? state.contentTags.filter((t) => t !== tag) : [...state.contentTags, tag] }
}

export function availableBranches(organization: OrganizationKey | null, creators: MockCreator[]): BranchKey[] {
  const scoped = organization ? creators.filter((c) => c.organization === organization) : creators
  return Array.from(new Set(scoped.map((c) => c.branch)))
}

export function availableGroupKeys(organization: OrganizationKey | null, branch: BranchKey | null, creators: MockCreator[]): GroupKey[] {
  const scoped = creators.filter(
    (c) => (organization === null || c.organization === organization) && (branch === null || c.branch === branch),
  )
  return Array.from(new Set(scoped.flatMap((c) => c.groupKey))).filter((key) => key !== "NO")
}

/** Matches a single item's classification fields against the filter state:
 * OR within one dimension (e.g. any selected groupKey), AND across dimensions.
 * An omitted (null/empty) dimension means "All" for that dimension. */
export function matchesClassification(
  item: {
    organization: OrganizationKey
    branch: BranchKey
    groupKey: GroupKey[]
    channelType: ChannelType
    lifecycleStage: LifecycleStage
  },
  state: FilterState,
): boolean {
  if (state.organization !== null && item.organization !== state.organization) return false
  if (state.branch !== null && item.branch !== state.branch) return false
  if (state.groupKey.length > 0 && !item.groupKey.some((key) => state.groupKey.includes(key))) return false
  if (state.channelType !== null && item.channelType !== state.channelType) return false
  if (state.lifecycleStage !== null && item.lifecycleStage !== state.lifecycleStage) return false
  return true
}

export function matchesContent(
  item: { contentTags: ContentTagKey[]; contentFormat: ContentFormat },
  state: FilterState,
): boolean {
  if (state.contentTags.length > 0 && !item.contentTags.some((tag) => state.contentTags.includes(tag))) return false
  if (state.contentFormat !== null && item.contentFormat !== state.contentFormat) return false
  return true
}
