import { useId, useState } from "react"
import { Check, X } from "lucide-react"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"
import { useNotificationSaveFailed } from "../hooks/notificationSaveStatus"
import { useDeliverySlots } from "../hooks/useDeliverySlots"
import { ALL_DELIVERY_SLOTS, MAX_DELIVERY_SLOTS, MIN_DELIVERY_SLOTS } from "../model/deliverySlots"

/** Picks the (at most 4) half-hour times of the user's own day at which new-video pushes are delivered. */
export function NewVideoDeliveryTimes() {
  const [locale] = useLocale()
  const { slots, toggleSlot } = useDeliverySlots()
  // The failure flag is page-wide (the member drawer raises it too): only this section's own failed change is shown here.
  const saveFailed = useNotificationSaveFailed()
  const [failedHere, setFailedHere] = useState(false)
  const titleId = useId()

  const change = (slot: string) => void toggleSlot(slot).then((committed) => setFailedHere(!committed))

  const atMax = slots.length >= MAX_DELIVERY_SLOTS
  const atMin = slots.length <= MIN_DELIVERY_SLOTS

  return (
    <section className="notification-delivery-times" aria-labelledby={titleId}>
      <h2 className="notification-delivery-times__title" id={titleId}>
        {t(locale, "notificationSettings.deliveryTimes.title")}
      </h2>
      <p className="notification-delivery-times__description">{t(locale, "notificationSettings.deliveryTimes.description")}</p>

      {saveFailed && failedHere && (
        <p className="notification-delivery-times__error" role="alert">
          {t(locale, "notificationSettings.saveFailed")}
        </p>
      )}

      <div className="notification-delivery-times__selection">
        <ul className="notification-delivery-times__chips" aria-label={t(locale, "notificationSettings.deliveryTimes.selectedTimesLabel")}>
          {slots.map((slot) => (
            <li key={slot} className="notification-delivery-times__chip">
              <span className="notification-delivery-times__chip-time">{slot}</span>
              <button
                type="button"
                className="notification-delivery-times__chip-remove"
                aria-label={t(locale, "notificationSettings.deliveryTimes.removeAriaLabel", { time: slot })}
                disabled={atMin}
                onClick={() => change(slot)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        <span className="notification-delivery-times__count" aria-live="polite">
          {t(locale, "notificationSettings.deliveryTimes.selectedCount", { count: String(slots.length), max: String(MAX_DELIVERY_SLOTS) })}
        </span>
      </div>

      {(atMax || atMin) && (
        <p className="notification-delivery-times__hint" role="note">
          {t(locale, atMax ? "notificationSettings.deliveryTimes.maxReachedHint" : "notificationSettings.deliveryTimes.minRequiredHint")}
        </p>
      )}

      <div className="notification-delivery-times__grid" role="group" aria-label={t(locale, "notificationSettings.deliveryTimes.gridAriaLabel")}>
        {ALL_DELIVERY_SLOTS.map((slot) => {
          const selected = slots.includes(slot)
          return (
            <button
              key={slot}
              type="button"
              className={`notification-delivery-times__slot${selected ? " is-selected" : ""}`}
              aria-pressed={selected}
              disabled={selected ? atMin : atMax}
              onClick={() => change(slot)}
            >
              {selected && <Check size={12} strokeWidth={3} aria-hidden="true" />}
              {slot}
            </button>
          )
        })}
      </div>
    </section>
  )
}
