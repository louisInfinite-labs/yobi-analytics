import { useEffect, useState } from "react"
import { Button, Drawer, Segmented } from "antd"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"
import { REMINDER_TIME_LABEL_KEYS, REMINDER_TIME_VALUES, type ReminderSetting, type ReminderTimeValue } from "../../notifications/model/notificationTopics"
import { useStreamNotificationOverride } from "../hooks/useStreamNotificationOverride"
import type { ScheduledStream } from "../model/scheduledStream"

interface StreamNotificationPanelProps {
  stream: ScheduledStream | null
  onClose: () => void
}

/** The Segmented value used while this stream has no reminder at all: not one of the
 * options, so no option appears selected (never a silently pre-picked time). */
const NO_SELECTION = "__none__"

/** Schedule's single-stream notification setting (opened from
 * StreamDetailModal's "Set Reminder" button): the SAME reminder-timing
 * control Settings uses for a creator + topic (same REMINDER_TIME_VALUES/
 * labels, same shared-filter-segmented skin) -- applied to exactly ONE stream
 * instead. Deliberately no "unset" option here: it only ever SETS a reminder
 * for this one stream.
 *
 * Opening this panel never writes anything -- only Save does. The value shown
 * is the reminder that currently applies to this stream (useStreamNotificationOverride's
 * getEffectiveReminderValue: this stream's own saved override, else the creator's 全部
 * reminder, else the creator + topic reminder) -- or NOTHING selected when no reminder is
 * set, never a fabricated default. Saving writes this stream's own override, which outranks
 * the creator's 全部 and topic reminders for this stream only and never changes them. */
export function StreamNotificationPanel({ stream, onClose }: StreamNotificationPanelProps) {
  const [locale] = useLocale()
  const { getEffectiveReminderValue, saveOverride } = useStreamNotificationOverride()
  const [draft, setDraft] = useState<ReminderSetting>(null)
  // Tracks whether the user has changed the control since this stream was
  // opened -- the underlying effective value can itself change shortly
  // after mount (the backend-backed cache below finishes its initial
  // fetch), and that must still refresh the shown value, but only while
  // nothing the user picked is waiting to be saved.
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)

  useEffect(() => {
    setDirty(false)
    setSaving(false)
    setSaveFailed(false)
  }, [stream?.videoId])

  useEffect(() => {
    if (stream && !dirty) setDraft(getEffectiveReminderValue(stream))
  }, [stream, dirty, getEffectiveReminderValue])

  if (!stream) return null

  const options = REMINDER_TIME_VALUES.map((value) => ({ value, label: t(locale, REMINDER_TIME_LABEL_KEYS[value]) }))

  async function handleSave() {
    if (!stream || draft === null) return
    setSaving(true)
    setSaveFailed(false)
    try {
      await saveOverride(stream, draft)
      onClose()
    } catch {
      // Keep the drawer open (the user's pick is still in `draft`) and say so,
      // rather than leaving an unhandled rejection and a silent no-op.
      setSaveFailed(true)
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
          value={draft ?? NO_SELECTION}
          options={options}
          onChange={(value) => {
            setDirty(true)
            setDraft(value as ReminderTimeValue)
          }}
          aria-label={t(locale, "liveSchedule.setReminderButton")}
        />
        {draft === null ? <p className="stream-reminder-section__description">{t(locale, "liveSchedule.streamReminderUnsetHint")}</p> : null}
      </section>
      {saveFailed ? (
        <p role="alert" className="stream-reminder-error">
          {t(locale, "liveSchedule.saveReminderFailed")}
        </p>
      ) : null}
      <div className="stream-reminder-actions">
        <Button type="primary" onClick={handleSave} disabled={saving || draft === null} loading={saving}>
          {t(locale, "liveSchedule.saveReminderButton")}
        </Button>
      </div>
    </Drawer>
  )
}
