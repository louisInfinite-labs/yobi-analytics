import { availableBranches, availableGroupKeys, type FilterState } from "../../lib/filterState"
import { mockCreators } from "../../data/mockCreators"
import type { BranchKey, ChannelType, ContentFormat, ContentTagKey, GroupKey, LifecycleStage, OrganizationKey } from "../../types/domain"
import { BranchFilter } from "./BranchFilter"
import { ChannelTypeFilter } from "./ChannelTypeFilter"
import { ContentFormatFilter } from "./ContentFormatFilter"
import { ContentTagFilter } from "./ContentTagFilter"
import { LifecycleStageFilter } from "./LifecycleStageFilter"
import { OrganizationFilter } from "./OrganizationFilter"
import { TagFilter } from "./TagFilter"

interface ClassificationFilterBarProps {
  state: FilterState
  onOrganizationChange: (value: OrganizationKey | null) => void
  onBranchChange: (value: BranchKey | null) => void
  onGroupKeyToggle: (key: GroupKey) => void
  onChannelTypeChange: (value: ChannelType | null) => void
  onLifecycleStageChange: (value: LifecycleStage | null) => void
  onContentTagToggle: (tag: ContentTagKey) => void
  onContentFormatChange: (value: ContentFormat | null) => void
}

/** Composes every creator- and video-level filter dimension into one bar,
 * sharing one FilterState so KPI cards, charts, rankings, and the table all
 * stay in sync (dashboard_ui_direction_en.md section 10). */
export function ClassificationFilterBar({
  state,
  onOrganizationChange,
  onBranchChange,
  onGroupKeyToggle,
  onChannelTypeChange,
  onLifecycleStageChange,
  onContentTagToggle,
  onContentFormatChange,
}: ClassificationFilterBarProps) {
  const branches = availableBranches(state.organization, mockCreators)
  const groupKeys = availableGroupKeys(state.organization, state.branch, mockCreators)

  return (
    <div className="filter-bar">
      <OrganizationFilter value={state.organization} onChange={onOrganizationChange} />
      <BranchFilter value={state.branch} options={branches} onChange={onBranchChange} />
      <TagFilter selected={state.groupKey} options={groupKeys} onToggle={onGroupKeyToggle} />
      <ChannelTypeFilter value={state.channelType} onChange={onChannelTypeChange} />
      <LifecycleStageFilter value={state.lifecycleStage} onChange={onLifecycleStageChange} />
      <ContentTagFilter selected={state.contentTags} onToggle={onContentTagToggle} />
      <ContentFormatFilter value={state.contentFormat} onChange={onContentFormatChange} />
    </div>
  )
}
