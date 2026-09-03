import { useState } from "react"
import { mockCreators } from "../data/mockCreators"
import {
  EMPTY_FILTER_STATE,
  setBranch,
  setOrganization,
  toggleContentTag,
  toggleGroupKey,
  type FilterState,
} from "../lib/filterState"
import type { ChannelType, ContentFormat, ContentTagKey, GroupKey, LifecycleStage, OrganizationKey } from "../types/domain"

export function useFilterState() {
  const [state, setState] = useState<FilterState>(EMPTY_FILTER_STATE)

  return {
    state,
    setOrganization: (value: OrganizationKey | null) => setState((s) => setOrganization(s, value, mockCreators)),
    setBranch: (value: FilterState["branch"]) => setState((s) => setBranch(s, value, mockCreators)),
    toggleGroupKey: (key: GroupKey) => setState((s) => toggleGroupKey(s, key)),
    setChannelType: (value: ChannelType | null) => setState((s) => ({ ...s, channelType: value })),
    setLifecycleStage: (value: LifecycleStage | null) => setState((s) => ({ ...s, lifecycleStage: value })),
    toggleContentTag: (tag: ContentTagKey) => setState((s) => toggleContentTag(s, tag)),
    setContentFormat: (value: ContentFormat | null) => setState((s) => ({ ...s, contentFormat: value })),
    reset: () => setState(EMPTY_FILTER_STATE),
  }
}
