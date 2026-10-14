import { useId, useState } from "react"
import { Button } from "antd"
import { PlusIcon } from "@phosphor-icons/react"
import { X } from "lucide-react"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { useTimeFormat } from "../../../shared/i18n/hooks/useTimeFormat"
import { t } from "../../../shared/i18n/translations"
import { useNotificationSaveFailed } from "../hooks/notificationSaveStatus"
import { useDeliverySlots } from "../hooks/useDeliverySlots"
import { ALL_DELIVERY_SLOTS, formatDeliverySlot, MAX_DELIVERY_SLOTS, MIN_DELIVERY_SLOTS } from "../model/deliverySlots"

/** Picks the (1 to 4) half-hour times of the user's OWN day at which new-video pushes are delivered -- always their local clock, in
 * their display format (24h / 12h). One dropdown per chosen time (default 08:00 and 18:00) and a "+" box to add another, up to the maximum.
 * What is stored and sent is the canonical "HH:MM" local time plus the browser's IANA time zone; the backend does the conversion. */
export function NewVideoDeliveryTimes() {
  const [locale] = useLocale()
  const [timeFormat] = useTimeFormat()
  const { slots, addSlot, removeSlot, changeSlot } = useDeliverySlots()
  // The failure flag is page-wide (the member drawer raises it too): only this section's own failed change is shown here.
  const saveFailed = useNotificationSaveFailed()
  const [failedHere, setFailedHere] = useState(false)
  const titleId = useId()

  const track = (committed: Promise<boolean>) => void committed.then((done) => setFailedHere(!done))
  const atMax = slots.length >= MAX_DELIVERY_SLOTS
  const atMin = slots.length <= MIN_DELIVERY_SLOTS

  return (
    <section className="notification-detail-section notification-delivery-times" aria-labelledby={titleId}>
      <h3 className="notification-detail-section__title" id={titleId}>
        {t(locale, "notificationSettings.deliveryTimes.title")}
      </h3>
      <p className="notification-detail-section__description">{t(locale, "notificationSettings.deliveryTimes.description")}</p>

      {saveFailed && failedHere && (
        <p className="notification-delivery-times__error" role="alert">
          {t(locale, "notificationSettings.saveFailed")}
        </p>
      )}

      <ul className="notification-delivery-times__list" aria-label={t(locale, "notificationSettings.deliveryTimes.listAriaLabel")}>
        {slots.map((slot, index) => (
          <li key={slot} className="notification-delivery-times__item">
            <select
              className="notification-delivery-times__select"
              aria-label={t(locale, "notificationSettings.deliveryTimes.timeAriaLabel", { index: String(index + 1) })}
              value={slot}
              onChange={(event) => track(changeSlot(slot, event.target.value))}
            >
              {ALL_DELIVERY_SLOTS.map((option) => (
                // A time another row already uses is not selectable here, so duplicates cannot be picked at all.
                <option key={option} value={option} disabled={option !== slot && slots.includes(option)}>
                  {formatDeliverySlot(option, timeFormat)}
                </option>
              ))}
            </select>
            {!atMin && (
              <button
                type="button"
                className="notification-delivery-times__remove"
                aria-label={t(locale, "notificationSettings.deliveryTimes.removeAriaLabel", { time: formatDeliverySlot(slot, timeFormat) })}
                onClick={() => track(removeSlot(slot))}
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
        {!atMax && (
          <li className="notification-delivery-times__item">
            <Button
              variant="dashed"
              className="notification-add-time"
              aria-label={t(locale, "notificationSettings.deliveryTimes.addAriaLabel")}
              onClick={() => track(addSlot())}
            >
              <PlusIcon size={16} weight="regular" aria-hidden="true" />
            </Button>
          </li>
        )}
      </ul>
    </section>
  )
}
