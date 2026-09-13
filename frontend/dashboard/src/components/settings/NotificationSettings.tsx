import { useMutedNotificationCreators } from "../../hooks/useMutedNotificationCreators"
import { groupCreatorsForNotificationSettings, type NotificationCreator } from "../../lib/notificationCreatorGrouping"
import { BRANCH_LABELS } from "../../types/domain"

function CreatorRow({ creator }: { creator: NotificationCreator }) {
  const { isSubscribed, toggleSubscribed } = useMutedNotificationCreators()
  const subscribed = isSubscribed(creator.creatorId)

  return (
    <label className="notification-settings__row">
      <span className="notification-settings__creator-name">{creator.displayName}</span>
      <span className="notification-settings__switch">
        <input
          type="checkbox"
          checked={subscribed}
          onChange={() => toggleSubscribed(creator.creatorId)}
          aria-label={creator.displayName}
        />
        <span className="notification-settings__switch-track" aria-hidden="true" />
      </span>
    </label>
  )
}

/** Notification Settings' content: every creator in the real Creator
 * Master roster (src/lib/notificationCreatorGrouping.ts -- 112 as of this
 * roster, not the small mockCreators.ts used elsewhere), grouped
 * VSPO JP / VSPO EN / hololive JP (generation, then Dev_IS) / hololive EN
 * (Myth/Promise/Advent/Justice) / hololive ID (generation), per this
 * feature's own spec. Each row is a per-creator push-notification toggle
 * (see useMutedNotificationCreators), on by default. */
export function NotificationSettings() {
  const branchGroups = groupCreatorsForNotificationSettings()

  return (
    <div className="notification-settings">
      {branchGroups.map((branchGroup) => (
        <section key={branchGroup.branch} className="notification-settings__branch">
          <h2 className="notification-settings__branch-title">{BRANCH_LABELS[branchGroup.branch]}</h2>
          {branchGroup.subgroups.map((subgroup) => (
            <div key={subgroup.label ?? "__flat__"} className="notification-settings__subgroup">
              {subgroup.label && <h3 className="notification-settings__subgroup-title">{subgroup.label}</h3>}
              <div className="notification-settings__list">
                {subgroup.creators.map((creator) => (
                  <CreatorRow key={creator.creatorId} creator={creator} />
                ))}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}
