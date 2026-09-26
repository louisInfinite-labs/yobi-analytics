import { useState } from "react"
import { ScheduleGrid } from "../../features/live-schedule/components/ScheduleGrid"
import { ScheduleToolbar } from "../../features/live-schedule/components/ScheduleToolbar"
import { StreamDetailModal } from "../../features/live-schedule/components/StreamDetailModal"
import { useWeeklySchedule } from "../../features/live-schedule/hooks/useWeeklySchedule"
import type { ScheduledStream } from "../../features/live-schedule/model/scheduledStream"
import { VideoPlayerModal } from "../../features/media-player/components/VideoPlayerModal"
import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { t } from "../../shared/i18n/translations"
import "./styles/schedule.css"

/** New standalone page (spec: "brand-new page", not a repurposing of Home or
 * any other existing page) -- renders inside the existing app-shell's
 * content area next to MainNavbar, same as Home/Dashboard/Settings, rather
 * than building its own sidebar/full-viewport shell. */
export function LiveSchedulePage() {
  const [locale] = useLocale()
  const { weekStart, days, now, goToPreviousWeek, goToNextWeek } = useWeeklySchedule()
  const [selectedStream, setSelectedStream] = useState<ScheduledStream | null>(null)
  const [embed, setEmbed] = useState<{ videoId: string; title: string } | null>(null)

  return (
    <div className="schedule-page">
      <header className="schedule-header">
        <div>
          <h1 className="schedule-title">{t(locale, "liveSchedule.pageTitle")}</h1>
          <div className="schedule-subtitle">{t(locale, "liveSchedule.pageSubtitle")}</div>
        </div>

        <ScheduleToolbar locale={locale} weekStart={weekStart} onPreviousWeek={goToPreviousWeek} onNextWeek={goToNextWeek} />
      </header>

      <ScheduleGrid locale={locale} days={days} now={now} selectedStreamId={selectedStream?.id ?? null} onSelectStream={setSelectedStream} />

      <StreamDetailModal
        stream={selectedStream}
        locale={locale}
        now={now}
        onClose={() => setSelectedStream(null)}
        onOpenStream={(stream) => {
          setSelectedStream(null)
          setEmbed({ videoId: stream.videoId, title: stream.title })
        }}
      />

      {embed && <VideoPlayerModal videoId={embed.videoId} title={embed.title} variant="player-only" onClose={() => setEmbed(null)} />}
    </div>
  )
}
