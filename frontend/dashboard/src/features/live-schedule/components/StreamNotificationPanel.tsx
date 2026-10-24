import { useEffect, useState } from "react"
import { Button, Drawer, Segmented } from "antd"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"
import { ensurePushEnabled } from "../../notifications/push/pushGate"
import { isPremiereReminderTime, PREMIERE_REMINDER_TIME_VALUES, REMINDER_TIME_LABEL_KEYS, REMINDER_TIME_VALUES } from "../../notifications/model/notificationTopics"
import { STREAM_REMINDER_OFF, usePremiereReminder, useStreamNotificationOverride, type StreamReminderChoice } from "../hooks/useStreamNotificationOverride"
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
 * instead. Only real reminder timings are offered (no "off" choice): it only ever SETS a reminder
 * for this one stream.
 *
 * Opening this panel never writes anything -- only Save does. The value shown
 * is the reminder that currently applies to this stream (useStreamNotificationOverride's
 * getEffectiveReminderValue: this stream's own saved override, else the creator's 全部
 * reminder, else the creator + topic reminder) -- or NOTHING selected when no reminder is
 * set, never a fabricated default. Saving writes this stream's own override, which outranks
 * the creator's 全部 and topic reminders for this stream only and never changes them.
 *
 * For a Premiere (stream.status === "premiere") the SAME panel sets a different thing: the ONE-TIME Premiere reminder (usePremiereReminder). The control, the
 * Save / Remove interaction and the times (except 1 minute, which a Premiere reminder no longer offers) are identical, but the value is only this Premiere's own saved reminder (there is no creator fallback and no
 * "advance and start" pair), the first choice reads 首播時 instead of 開播時, the texts say Premiere, and Remove cancels the reminder. */
export function StreamNotificationPanel({ stream, onClose }: StreamNotificationPanelProps) {
  const [locale] = useLocale()
  const { getEffectiveReminderValue, getOverride, saveOverride, removeOverride } = useStreamNotificationOverride()
  const { getPremiereReminder, savePremiereReminder, removePremiereReminder } = usePremiereReminder()
  const [draft, setDraft] = useState<StreamReminderChoice | null>(null)
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
    if (stream && !dirty) setDraft(stream.status === "premiere" ? getPremiereReminder(stream.videoId) : getEffectiveReminderValue(stream))
  }, [stream, dirty, getEffectiveReminderValue, getPremiereReminder])

  if (!stream) return null

  const isPremiere = stream.status === "premiere"
  const options = (isPremiere ? PREMIERE_REMINDER_TIME_VALUES : REMINDER_TIME_VALUES).map((value) => ({
    value: value as StreamReminderChoice,
    label: t(locale, isPremiere && value === "at_start" ? "liveSchedule.premiereReminder.atStart" : REMINDER_TIME_LABEL_KEYS[value]),
  }))
  // A previously stored per-stream OFF override is not an offered choice any more: it reads as "nothing selected" here (Remove still clears it).
  // A Premiere reminder saved before the 1-minute choice was retired still reads "1min": it matches no offered choice, so it shows as nothing selected
  // (with its own hint and Cancel), is never converted to another time, and is replaced only by a choice the user picks and saves.
  const retiredPremiereChoice = isPremiere && draft === "1min"
  const shown = draft === STREAM_REMINDER_OFF || retiredPremiereChoice ? null : draft
  const hasOwnOverride = isPremiere ? getPremiereReminder(stream.videoId) !== null : getOverride(stream.videoId) !== null

  async function handleSave() {
    if (!stream || shown === null) return
    setSaving(true)
    setSaveFailed(false)
    try {
      // A one-time reminder is a notification being turned ON: it is only saved once this device can really deliver Web Push (the
      // explanation + browser prompt on first use). Cancelled / denied / unavailable: nothing is saved, and the drawer stays open
      // with the user's pick intact (the gate already showed why).
      if ((await ensurePushEnabled()) !== "ready") return
      if (isPremiere) {
        if (!isPremiereReminderTime(shown)) return
        await savePremiereReminder(stream, shown)
      } else {
        await saveOverride(stream, shown)
      }
      onClose()
    } catch {
      // Keep the drawer open (the user's pick is still in `draft`) and say so,
      // rather than leaving an unhandled rejection and a silent no-op.
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }

  async function handleRemove() {
    if (!stream) return
    setSaving(true)
    setSaveFailed(false)
    try {
      await (isPremiere ? removePremiereReminder(stream) : removeOverride(stream))
      onClose()
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer open onClose={onClose} title={t(locale, "liveSchedule.setReminderButton")} size={420} className="stream-reminder-drawer">
      <section className="stream-reminder-section">
        <p className="stream-reminder-section__description">
          {t(locale, isPremiere ? "liveSchedule.premiereReminderExplanationLine1" : "liveSchedule.streamReminderExplanationLine1")}
        </p>
        <p className="stream-reminder-section__description">
          {t(locale, isPremiere ? "liveSchedule.premiereReminderExplanationLine2" : "liveSchedule.streamReminderExplanationLine2")}
        </p>
        <Segmented
          className={`stream-reminder-options shared-filter-segmented${isPremiere ? " stream-reminder-options--premiere" : ""}`}
          value={shown ?? NO_SELECTION}
          options={options}
          onChange={(value) => {
            setDirty(true)
            setDraft(value as StreamReminderChoice)
          }}
          aria-label={t(locale, "liveSchedule.setReminderButton")}
        />
        {shown === null ? (
          <p className="stream-reminder-section__description">
            {t(locale, retiredPremiereChoice ? "liveSchedule.premiereReminderRetiredHint" : isPremiere ? "liveSchedule.premiereReminderUnsetHint" : "liveSchedule.streamReminderUnsetHint")}
          </p>
        ) : null}
      </section>
      {saveFailed ? (
        <p role="alert" className="stream-reminder-error">
          {t(locale, "liveSchedule.saveReminderFailed")}
        </p>
      ) : null}
      <div className="stream-reminder-actions">
        {hasOwnOverride ? (
          <Button onClick={handleRemove} disabled={saving}>
            {t(locale, isPremiere ? "liveSchedule.removePremiereReminderButton" : "liveSchedule.removeStreamReminderButton")}
          </Button>
        ) : null}
        <Button type="primary" onClick={handleSave} disabled={saving || shown === null} loading={saving}>
          {t(locale, "liveSchedule.saveReminderButton")}
        </Button>
      </div>
    </Drawer>
  )
}
