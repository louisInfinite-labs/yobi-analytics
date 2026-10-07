import { useEffect, useState } from "react"
import { Button, Drawer, Segmented } from "antd"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"
import { REMINDER_TIME_LABEL_KEYS, REMINDER_TIME_VALUES, type ReminderTimeValue } from "../../notifications/model/notificationTopics"
import { useStreamNotificationOverride } from "../hooks/useStreamNotificationOverride"
import type { ScheduledStream } from "../model/scheduledStream"

interface StreamNotificationPanelProps {
  stream: ScheduledStream | null
  onClose: () => void
}

/** Schedule's single-stream notification setting (opened from
 * StreamDetailModal's "Set Reminder" button): the SAME reminder-timing
 * control Settings' own ReminderTimeSection uses for a topic (same
 * REMINDER_TIME_VALUES/labels, same shared-filter-segmented skin) --
 * applied to exactly ONE stream instead. Deliberately no "member_choice"
 * option here: that sentinel means "defer to each member's own setting",
 * a topic-level concept with no meaning for one specific stream.
 *
 * Opening this panel never writes anything -- only Save does. The initial
 * value shown is this stream's real backend-persisted override if one
 * exists, else its creator's real backend-persisted recurring setting,
 * else the existing system default (useStreamNotificationOverride's
 * getEffectiveReminderValue) -- never a localStorage value and never a
 * fabricated Schedule-specific default. Saving replaces, not combines
 * with, the creator's recurring reminder for this one stream. */
export function StreamNotificationPanel({ stream, onClose }: StreamNotificationPanelProps) {
  const [locale] = useLocale()
  const { getEffectiveReminderValue, saveOverride } = useStreamNotificationOverride()
  const [draft, setDraft] = useState<ReminderTimeValue | null>(null)
  // Tracks whether the user has changed the control since this stream was
  // opened -- the underlying effective value can itself change shortly
  // after mount (the backend-backed cache below finishes its initial
  // fetch), and that must still refresh the shown value, but only while
  // nothing the user picked is waiting to be saved.
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDirty(false)
    setSaving(false)
  }, [stream?.videoId])

  useEffect(() => {
    if (stream && !dirty) setDraft(getEffectiveReminderValue(stream))
  }, [stream, dirty, getEffectiveReminderValue])

  if (!stream || draft === null) return null

  const options = REMINDER_TIME_VALUES.map((value) => ({ value, label: t(locale, REMINDER_TIME_LABEL_KEYS[value]) }))

  async function handleSave() {
    if (!stream || draft === null) return
    setSaving(true)
    try {
      await saveOverride(stream, draft)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer open onClose={onClose} title={t(locale, "liveSchedule.setReminderButton")} size={420} className="stream-reminder-drawer">
      <section className="stream-reminder-section">
        <p className="stream-reminder-section__description">{t(locale, "liveSchedule.streamReminderExplanationLine1")}</p>
        <p className="stream-reminder-section__description">{t(locale, "liveSchedule.streamReminderExplanationLine2")}</p>
        <Segmented
          className="stream-reminder-options shared-filter-segmented"
          value={draft}
          options={options}
          onChange={(value) => {
            setDirty(true)
            setDraft(value as ReminderTimeValue)
          }}
          aria-label={t(locale, "liveSchedule.setReminderButton")}
        />
      </section>
      <div className="stream-reminder-actions">
        <Button type="primary" onClick={handleSave} disabled={saving} loading={saving}>
          {t(locale, "liveSchedule.saveReminderButton")}
        </Button>
      </div>
    </Drawer>
  )
}
