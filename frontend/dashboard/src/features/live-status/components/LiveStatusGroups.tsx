import { Fragment, type ReactNode } from "react"
import type { BranchKey } from "../../../entities/creator/model/domain"
import { GAMERS_GROUP_LABEL_KEY, OTHER_GROUP_LABEL_KEY } from "../../../entities/creator/utils/hololiveSubgrouping"
import { t, type Locale } from "../../../shared/i18n/translations"

/** Every subgroup label is a real, locale-independent generation/unit name (e.g. "1期生", "FLOW GLOW") EXCEPT the two sentinel keys below. */
export function liveStatusSubgroupTitle(locale: Locale, label: string): string {
  if (label === OTHER_GROUP_LABEL_KEY) return t(locale, "creatorStatusList.otherGroupLabel")
  if (label === GAMERS_GROUP_LABEL_KEY) return t(locale, "creatorStatusList.gamersGroupLabel")
  return label
}

/** "VSPO! // JP" / "HOLOLIVE // EN" -- the ONE organization-header text, shared by Live Status and every other roster view that follows
 * Live Status' grouping (Schedule's creator filter, the notification member drawer). This only formats the heading TEXT: which creators
 * belong to which branch, the branch order, the subgroups and the member order all come from groupEligibleCreatorsForLiveStatus. */
export function formatBranchHeading(branch: BranchKey): string {
  const org = branch.startsWith("vspo") ? "VSPO!" : "HOLOLIVE"
  const region = branch.endsWith("_jp") ? "JP" : branch.endsWith("_en") ? "EN" : "ID"
  return `${org} // ${region}`
}

/** A branch group's shape -- structurally what groupEligibleCreatorsForLiveStatus returns, for any creator type a caller maps its creators to. */
export interface BranchGroupLike<T> {
  branch: BranchKey
  subgroups: { label: string | null; creators: T[] }[]
}

/** Live Status' own group layout, for any other list of creators: for each branch group a "VSPO! // JP" heading (the same
 * .live-status-group__heading), each labelled subgroup's own subheading, and an unlabeled trailing block (the organization channel)
 * set off by the same divider -- exactly as CreatorStatusList draws them. The caller supplies the groups (always from
 * groupEligibleCreatorsForLiveStatus, so grouping and order are Live Status') and how one subgroup's creators are drawn. */
export function LiveStatusGroups<T>({
  groups,
  locale,
  renderSubgroup,
}: {
  groups: BranchGroupLike<T>[]
  locale: Locale
  renderSubgroup: (creators: T[], subgroupLabel: string | null) => ReactNode
}) {
  return (
    <>
      {groups.map((group) => (
        <div key={group.branch} className="live-status-group" data-branch={group.branch}>
          <div className="live-status-group__heading">
            <span>{formatBranchHeading(group.branch)}</span>
          </div>
          {group.subgroups.map((subgroup, subgroupIndex) => (
            <Fragment key={subgroup.label ?? "__flat__"}>
              {subgroup.label && <div className="live-status-group__subheading">{liveStatusSubgroupTitle(locale, subgroup.label)}</div>}
              {!subgroup.label && subgroupIndex > 0 && <div className="live-status-group__org-divider" aria-hidden="true" />}
              {renderSubgroup(subgroup.creators, subgroup.label)}
            </Fragment>
          ))}
        </div>
      ))}
    </>
  )
}
