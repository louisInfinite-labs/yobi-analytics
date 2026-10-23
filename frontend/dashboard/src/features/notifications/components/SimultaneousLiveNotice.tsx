import { useId, useState } from "react"
import { Switch } from "antd"
import { useBreakpoint } from "../../../shared/hooks/useBreakpoint"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"
import { useNotificationSaveFailed } from "../hooks/notificationSaveStatus"
import { useSimultaneousLiveNotice } from "../hooks/useSimultaneousLiveNotice"
import { NotificationCheckbox } from "./TopicCreatorManagementDrawer"

/** The opt-in for 同時直播預告: a notice (not a schedule view -- Schedule already has the 24-hour timeline) when two or more creators the user has
 * live notifications for are scheduled to start at the same time. One switch, off until the user turns it on; the choice is stored on the backend.
 * Like every other on/off control in Settings it is a square checkbox on a phone and an ON/OFF switch elsewhere (same value, same write). */
export function SimultaneousLiveNotice() {
  const [locale] = useLocale()
  const { enabled, loaded, setEnabled } = useSimultaneousLiveNotice()
  // The failure flag is page-wide (the member drawer and the delivery times raise it too): only this section's own failed change is shown here.
  const saveFailed = useNotificationSaveFailed()
  const [failedHere, setFailedHere] = useState(false)
  const phone = useBreakpoint() === "mobile"
  const titleId = useId()
  const title = t(locale, "notificationSettings.simultaneousLive.title")
  const onChange = (next: boolean) => void setEnabled(next).then((done) => setFailedHere(!done))

  return (
    <section className="notification-detail-section" aria-labelledby={titleId}>
      <div className="notification-members-heading">
        <div>
          <h3 className="notification-detail-section__title" id={titleId}>
            {title}
          </h3>
          <p className="notification-detail-section__description">{t(locale, "notificationSettings.simultaneousLive.description")}</p>
        </div>
        {phone ? (
          <NotificationCheckbox checked={enabled} onChange={onChange} ariaLabel={title} disabled={!loaded} />
        ) : (
          <Switch checked={enabled} disabled={!loaded} onChange={onChange} aria-label={title} />
        )}
      </div>
      {saveFailed && failedHere && (
        <p className="notification-delivery-times__error" role="alert">
          {t(locale, "notificationSettings.saveFailed")}
        </p>
      )}
    </section>
  )
}
