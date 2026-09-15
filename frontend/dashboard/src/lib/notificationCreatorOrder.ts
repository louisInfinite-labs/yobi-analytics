import type { MockCreator } from "../data/mockCreators"
import { findMockCreatorForCreatorId } from "./creatorFavoriteBridge"
import { DOCK_BRANCH_ORDER, pinNonMemberChannelsLast, sortWithinBranch } from "./dockCreatorOrder"
import type { NotificationCreator } from "./notificationCreatorGrouping"
import type { BranchKey } from "../types/domain"

/** Reorders `creators` (already known to share one `branch`) to match Live
 * Status's own display order for that branch -- reusing
 * lib/dockCreatorOrder.ts's own sortWithinBranch (gojuon kana for VSPO
 * JP/hololive JP, alphabetical elsewhere) via each creator's bridged
 * mockCreators counterpart, rather than a second, parallel copy of that
 * algorithm against creators.json. Confirmed with the user: Notification
 * Settings' creator management previously used creators.json's own raw,
 * undefined array order, which doesn't match Live Status at all -- this
 * makes the two consistent.
 *
 * A creatorId with no mockCreators counterpart at all (watson_amelia,
 * airani_iofifteen -- see creatorFavoriteBridge.ts) has no ordering
 * information to borrow, so it sorts after every bridged creator, in its
 * own creators.json declared order -- EXCEPT for vspo_jp, where a
 * non-member channel among them is pinned last regardless (see
 * dockCreatorOrder.ts's own pinNonMemberChannelsLast, reused here),
 * ahead of any other unbridged entry. */
export function sortNotificationCreatorsLikeLiveStatus(branch: BranchKey, creators: NotificationCreator[]): NotificationCreator[] {
  const bridged: { creator: NotificationCreator; mock: MockCreator }[] = []
  const unbridged: NotificationCreator[] = []
  for (const creator of creators) {
    const mock = findMockCreatorForCreatorId(creator.creatorId)
    if (mock) bridged.push({ creator, mock })
    else unbridged.push(creator)
  }

  const creatorByChannelId = new Map(bridged.map((entry) => [entry.mock.channelId, entry.creator]))
  const sortedBridged = sortWithinBranch(
    branch,
    bridged.map((entry) => entry.mock),
  ).map((mock) => creatorByChannelId.get(mock.channelId)!)

  const ordered = [...sortedBridged, ...unbridged]
  return branch === "vspo_jp" ? pinNonMemberChannelsLast(ordered) : ordered
}

/** Same per-branch reuse as above, applied to a flat, possibly cross-branch
 * list -- TopicCreatorManagementDrawer's own Favorites section is a single
 * flat list, not its own Agency/Region tree (this feature's own spec
 * section 6), so creators are grouped by DOCK_BRANCH_ORDER first (keeping
 * same-branch members adjacent, matching how Live Status would order the
 * same creators), then each branch's own slice is sorted exactly as
 * above. */
export function sortFlatNotificationCreatorsLikeLiveStatus(creators: NotificationCreator[]): NotificationCreator[] {
  return DOCK_BRANCH_ORDER.flatMap((branch) =>
    sortNotificationCreatorsLikeLiveStatus(
      branch,
      creators.filter((creator) => creator.branch === branch),
    ),
  )
}
