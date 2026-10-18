import type { CSSProperties, PointerEventHandler, Ref } from "react"
import type { Locale } from "../../../shared/i18n/translations"
import { t } from "../../../shared/i18n/translations"
import { useSecondClock } from "../hooks/useSecondClock"
import type { CreatorMilestonesState } from "../hooks/useCreatorMilestones"
import { anniversaryMilestone, birthdayMilestone } from "../model/milestoneCountdown"
import { formatAnniversaryLabel, formatCountdown, formatMilestoneDate } from "../model/milestoneFormat"

/** Shown for any value that is not available (loading, a failed read, no record) -- never a fabricated date or countdown. */
const VALUE_UNAVAILABLE = "—"

interface MilestoneDialogProps {
  id: string
  locale: Locale
  state: CreatorMilestonesState
  /** The measured overlay rectangle; the dialog renders nothing until it exists (never at a guessed size). */
  style: CSSProperties | null
  dialogRef: Ref<HTMLDivElement>
  onPointerEnter: PointerEventHandler<HTMLDivElement>
  onPointerLeave: PointerEventHandler<HTMLDivElement>
}

/** The countdown cell text: the localized "today" label for the WHOLE JST celebration day (00:00:00 through 23:59:59), the remaining time otherwise. */
function countdownText(locale: Locale, milestone: { isToday: boolean; countdown: Parameters<typeof formatCountdown>[1] }): string {
  return milestone.isToday ? t(locale, "oshiStatus.milestones.today") : formatCountdown(locale, milestone.countdown)
}

function Row({ label, date, countdown, hint }: { label: string; date: string; countdown: string; hint?: string }) {
  return (
    <div className="oshi-status__milestone-row" title={hint}>
      <span className="oshi-status__milestone-label">{label}</span>
      <span className="oshi-status__milestone-date">{date}</span>
      <span className="oshi-status__milestone-countdown">{countdown}</span>
    </div>
  )
}

/** The two milestone rows -- [label] [date] [countdown], no heading -- overlaid on the Oshi Status panel. It is mounted only while open, so the
 * one-second clock exists only then; the dates come from the (cached) milestones read and every number is derived from them here. */
export function MilestoneDialog({ id, locale, state, style, dialogRef, onPointerEnter, onPointerLeave }: MilestoneDialogProps) {
  const nowMs = useSecondClock(true)
  if (!style) return null

  const hint = state.status === "error" || state.status === "not_found" ? t(locale, "oshiStatus.milestones.unavailable") : undefined
  const birthday = state.status === "ready" ? birthdayMilestone(state.milestones.birthday, nowMs) : null
  const anniversary = state.status === "ready" ? anniversaryMilestone(state.milestones.debutDate, nowMs) : null

  return (
    <div
      id={id}
      ref={dialogRef}
      role="dialog"
      aria-label={t(locale, "oshiStatus.milestones.dialogLabel")}
      aria-busy={state.status === "loading"}
      className="oshi-status__milestone-dialog"
      style={style}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <Row
        label={t(locale, "oshiStatus.milestones.birthday")}
        date={birthday ? formatMilestoneDate(locale, birthday.month, birthday.day) : VALUE_UNAVAILABLE}
        countdown={birthday ? countdownText(locale, birthday) : VALUE_UNAVAILABLE}
        hint={hint}
      />
      <Row
        label={anniversary ? formatAnniversaryLabel(locale, anniversary.number) : t(locale, "oshiStatus.milestones.anniversaryUnknown")}
        date={anniversary ? formatMilestoneDate(locale, anniversary.month, anniversary.day) : VALUE_UNAVAILABLE}
        countdown={anniversary ? countdownText(locale, anniversary) : VALUE_UNAVAILABLE}
        hint={hint}
      />
      {/* The one reference line under the two rows: every target is 00:00 JST. Not a heading and not a row. */}
      <div className="oshi-status__milestone-caption">{t(locale, "oshiStatus.milestones.caption")}</div>
    </div>
  )
}