import { availableBranches, availableGroupKeys, type FilterState } from "./filterState"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import type { BranchKey, ChannelType, ContentFormat, ContentTagKey, GroupKey, LifecycleStage, OrganizationKey } from "../../../entities/creator/model/domain"
import { BranchFilter } from "./BranchFilter"
import { ChannelTypeFilter } from "./ChannelTypeFilter"
import { ContentFormatFilter } from "./ContentFormatFilter"
import { ContentTagFilter } from "./ContentTagFilter"
import { LifecycleStageFilter } from "./LifecycleStageFilter"
import { OrganizationFilter } from "./OrganizationFilter"
import { TagFilter } from "./TagFilter"
import { Button } from "antd"
import { RotateCcw } from "lucide-react"

interface ClassificationFilterBarProps {
  state: FilterState
  onOrganizationChange: (value: OrganizationKey | null) => void
  onBranchChange: (value: BranchKey | null) => void
  onGroupKeyToggle: (key: GroupKey) => void
  onChannelTypeChange: (value: ChannelType | null) => void
  onLifecycleStageChange: (value: LifecycleStage | null) => void
  onContentTagToggle: (tag: ContentTagKey) => void
  onContentFormatChange: (value: ContentFormat | null) => void
  onReset: () => void
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
  onReset,
}: ClassificationFilterBarProps) {
  const branches = availableBranches(state.organization, mockCreators)
  const groupKeys = availableGroupKeys(state.organization, state.branch, mockCreators)
  const activeCount = [
    state.organization,
    state.branch,
    state.channelType,
    state.lifecycleStage,
    state.contentFormat,
    ...state.groupKey,
    ...state.contentTags,
  ].filter(Boolean).length

  return (
    <section className="filter-bar" aria-labelledby="analytics-filter-title">
      <div className="filter-bar__header">
        <div>
          <h2 id="analytics-filter-title">Filter analytics</h2>
          <span>{activeCount === 0 ? "All dashboard data" : `${activeCount} active filter${activeCount === 1 ? "" : "s"}`}</span>
        </div>
        <Button type="text" icon={<RotateCcw size={15} />} disabled={activeCount === 0} onClick={onReset}>
          Clear filters
        </Button>
      </div>
      <div className="filter-bar__groups">
        <fieldset className="filter-bar__group">
          <legend>Creator scope</legend>
          <OrganizationFilter value={state.organization} onChange={onOrganizationChange} />
          <BranchFilter value={state.branch} options={branches} onChange={onBranchChange} />
          <TagFilter selected={state.groupKey} options={groupKeys} onToggle={onGroupKeyToggle} branch={state.branch} />
          <ChannelTypeFilter value={state.channelType} onChange={onChannelTypeChange} />
          <LifecycleStageFilter value={state.lifecycleStage} onChange={onLifecycleStageChange} />
        </fieldset>
        <fieldset className="filter-bar__group">
          <legend>Content scope</legend>
          <ContentTagFilter selected={state.contentTags} onToggle={onContentTagToggle} />
          <ContentFormatFilter value={state.contentFormat} onChange={onContentFormatChange} />
        </fieldset>
      </div>
    </section>
  )
}
