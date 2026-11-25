import type { ReactNode } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { OshiErrorState } from "./OshiErrorState"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import { t, type Locale } from "../../../shared/i18n/translations"
import type { MemoryVideo, OnThisDayResult } from "../data/onThisDay"
import { clampMonthDay, daysInMonth, shiftMonthDay, type MonthDay } from "../model/onThisDay"

const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1)

/** The previous-day / month / day / next-day controls of the On-this-day view. They reuse the Video List's own dropdown skin; February offers the 29th
 * (it has results in leap years only) and changing the month keeps the day inside it. */
export function MemoryDateControls({ monthDay, onChange, locale }: { monthDay: MonthDay; onChange: (next: MonthDay) => void; locale: Locale }) {
  const days = Array.from({ length: daysInMonth(monthDay.month) }, (_, index) => index + 1)
  return (
    <>
      <button
        type="button"
        className="oshi-videos__sort oshi-videos__memories-step"
        aria-label={t(locale, "memories.prevDayAria")}
        onClick={() => onChange(shiftMonthDay(monthDay, -1))}
      >
        <ChevronLeft size={12} aria-hidden="true" />
      </button>
      <select
        className="oshi-videos__sort oshi-videos__memories-select"
        value={monthDay.month}
        aria-label={t(locale, "memories.monthAria")}
        onChange={(event) => onChange(clampMonthDay({ month: Number(event.target.value), day: monthDay.day }))}
      >
        {MONTHS.map((month) => (
          <option key={month} value={month}>
            {month}
          </option>
        ))}
      </select>
      <select
        className="oshi-videos__sort oshi-videos__memories-select"
        value={monthDay.day}
        aria-label={t(locale, "memories.dayAria")}
        onChange={(event) => onChange({ month: monthDay.month, day: Number(event.target.value) })}
      >
        {days.map((day) => (
          <option key={day} value={day}>
            {day}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="oshi-videos__sort oshi-videos__memories-step"
        aria-label={t(locale, "memories.nextDayAria")}
        onClick={() => onChange(shiftMonthDay(monthDay, 1))}
      >
        <ChevronRight size={12} aria-hidden="true" />
      </button>
    </>
  )
}

/** A memory as the Video List's own card shape (the card opens it with the shelf's own selection path). */
function toCardVideo(video: MemoryVideo): RecentVideo {
  return {
    videoId: video.videoId,
    title: video.title,
    publishedAt: video.eventAt,
    contentFormat: video.contentType === "live" ? "live_archive" : video.contentType === "short" ? "shorts" : "normal_video",
    ...(typeof video.viewCount === "number" ? { viewCount: video.viewCount } : {}),
  }
}

/** "2024-03-15 · Streamed · Minecraft": the date and what that date means (a stream's real start vs an upload's published day), then the topic. */
function memoryMeta(video: MemoryVideo, locale: Locale, topicLabels: ReadonlyMap<string, string>): string {
  const kind = t(locale, video.dateKind === "actualStart" ? "memories.kind.actualStart" : "memories.kind.published")
  const topic = video.topic ? topicLabels.get(video.topic) : undefined
  return [video.date, kind, topic].filter(Boolean).join(" · ")
}

/** What the catalog can and cannot say about this view, in the user's language (never presented as "no videos"). */
function coverageNotes(result: OnThisDayResult, locale: Locale): string[] {
  const notes: string[] = []
  if (result.coverage.catalogStart) notes.push(t(locale, "memories.coverage", { date: result.coverage.catalogStart }))
  if (result.coverage.undatedLivestreams > 0) notes.push(t(locale, "memories.undated", { count: String(result.coverage.undatedLivestreams) }))
  if (result.truncated) notes.push(t(locale, "memories.truncated", { count: String(result.total) }))
  return notes
}

/** The On-this-day track's content: year groups (newest first) of the Video List's own cards, then a coverage note. The distinct states are loading, a
 * FAILED request (the shelf's own error state, never "no videos"), a creator without historical data, and a genuine empty date (with the coverage note so
 * it is clear what the catalog covers). */
export function OnThisDayContent({
  loading,
  error,
  result,
  locale,
  topicLabels,
  renderCard,
}: {
  loading: boolean
  error: Error | null
  result: OnThisDayResult
  locale: Locale
  topicLabels: ReadonlyMap<string, string>
  renderCard: (video: RecentVideo, meta: string) => ReactNode
}) {
  if (error) return <OshiErrorState error={error} />
  if (loading) return <div className="oshi-empty-state" role="status" aria-busy="true" />
  if (result.unavailable) return <div className="oshi-empty-state" role="status">{t(locale, "memories.unavailable")}</div>
  const notes = coverageNotes(result, locale)
  if (result.total === 0) {
    return (
      <div className="oshi-empty-state oshi-memories__empty" role="status">
        <span>{t(locale, "memories.empty")}</span>
        {notes.map((note) => (
          <span key={note} className="oshi-memories__note-line">
            {note}
          </span>
        ))}
      </div>
    )
  }
  return (
    <>
      {result.years.map((group) => (
        <section key={group.year} className="oshi-memories__year" aria-label={String(group.year)}>
          <h3 className="oshi-memories__year-label">{group.year}</h3>
          <div className="oshi-memories__cards">
            {group.videos.map((video) => (
              <span key={video.videoId} className="oshi-memories__card">
                {renderCard(toCardVideo(video), memoryMeta(video, locale, topicLabels))}
              </span>
            ))}
          </div>
        </section>
      ))}
      {notes.length > 0 && (
        <aside className="oshi-memories__note" role="note">
          {notes.map((note) => (
            <span key={note} className="oshi-memories__note-line">
              {note}
            </span>
          ))}
        </aside>
      )}
    </>
  )
}
