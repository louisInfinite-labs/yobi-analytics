import { t, type Locale } from "../../../shared/i18n/translations"
import { anniversaryMilestone, birthdayMilestone } from "../../oshi-status/model/milestoneCountdown"

/** Which of a creator two milestones fall on the current JST calendar day. */
export interface TodayMilestoneEvents {
  birthday: boolean
  debut: boolean
}

export type MilestoneIndicatorKind = "birthday" | "debut" | "both"

/** The shared Oshi Status milestone logic decides "today": a birthday and a debut anniversary are celebrated on the JST calendar day of their
 * occurrence (00:00:00 through 23:59:59), a Feb 29 follows the approved Feb 28 / Feb 29 rule, and the debut anniversary uses the ORIGINAL debut date (a
 * graduated creator keeps it; the debut day itself in the debut year is not an anniversary). Browser time zone never matters. */
export function todayMilestoneEvents(milestones: { birthday: string; debutDate: string }, nowMs: number): TodayMilestoneEvents {
  return {
    birthday: birthdayMilestone(milestones.birthday, nowMs)?.isToday === true,
    debut: anniversaryMilestone(milestones.debutDate, nowMs)?.isToday === true,
  }
}

export function milestoneIndicatorKind(events: TodayMilestoneEvents): MilestoneIndicatorKind | null {
  if (events.birthday && events.debut) return "both"
  if (events.birthday) return "birthday"
  if (events.debut) return "debut"
  return null
}

/** Only the creators with an event today, keyed by canonical creatorId. Pure: called once per JST day change, never per tick. */
export function computeTodayIndicators(
  milestonesById: Record<string, { birthday: string; debutDate: string }>,
  nowMs: number,
): Record<string, MilestoneIndicatorKind> {
  const indicators: Record<string, MilestoneIndicatorKind> = {}
  for (const [creatorId, milestones] of Object.entries(milestonesById)) {
    const kind = milestoneIndicatorKind(todayMilestoneEvents(milestones, nowMs))
    if (kind) indicators[creatorId] = kind
  }
  return indicators
}

/** "生日 當日" / "Birthday Today" / "誕生日&デビュー日 当日": the event label, one space, the Today label ONCE (a combined label for both events). */
export function milestoneIndicatorText(locale: Locale, kind: MilestoneIndicatorKind): string {
  const label = t(locale, kind === "both" ? "liveStatus.milestone.both" : kind === "birthday" ? "liveStatus.milestone.birthday" : "liveStatus.milestone.debut")
  return `${label} ${t(locale, "liveStatus.milestone.today")}`
}