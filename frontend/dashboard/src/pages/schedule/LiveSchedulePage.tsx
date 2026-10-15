import { useEffect, useMemo, useState } from "react"
import { flushSync } from "react-dom"
import { useFavoriteCreators } from "../../features/favorites/hooks/useFavoriteCreators"
import { buildCreatorFilterOptions, filterStreamsByOrganization, type ScheduleOrganizationFilter } from "../../features/live-schedule/model/scheduleCreatorFilter"
import { ScheduleGrid } from "../../features/live-schedule/components/ScheduleGrid"
import { ScheduleToolbar } from "../../features/live-schedule/components/ScheduleToolbar"
import { StreamDetailModal } from "../../features/live-schedule/components/StreamDetailModal"
import { StreamNotificationPanel } from "../../features/live-schedule/components/StreamNotificationPanel"
import { getScheduleCreatorName } from "../../features/live-schedule/utils/scheduleCreatorName"
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
  const [selectedCreators, setSelectedCreators] = useState<string[]>([])
  const selectedSet = useMemo(() => new Set(selectedCreators), [selectedCreators])
  const [organization, setOrganization] = useState<ScheduleOrganizationFilter>("all")
  const { weekStart, days, now, scheduleStreams } = useWeeklySchedule(selectedSet, organization)
  const { favorites } = useFavoriteCreators()
  // The filter dialog offers exactly the creators with an event on the displayed schedule, inside the chosen organization -- the same
  // streams and the same organization rule the grid itself is built from. Stored selections and Favorites are never edited by this.
  const creatorOptions = useMemo(
    () => buildCreatorFilterOptions(filterStreamsByOrganization(scheduleStreams, organization), favorites, getScheduleCreatorName),
    [scheduleStreams, organization, favorites],
  )
  const [selectedStream, setSelectedStream] = useState<ScheduledStream | null>(null)
  const [reminderStream, setReminderStream] = useState<ScheduledStream | null>(null)
  const [embed, setEmbed] = useState<{ videoId: string; title: string } | null>(null)

  // Scopes the document scrollbar's reference-matched style (schedule.css's
  // html.schedule-page-scroll rules) to only while this page is mounted --
  // <html> is shared across every page, so this must come off on unmount
  // rather than staying applied to Settings/Dashboard's own (unstyled)
  // document scrollbar afterward.
  useEffect(() => {
    document.documentElement.classList.add("schedule-page-scroll")
    return () => document.documentElement.classList.remove("schedule-page-scroll")
  }, [])

  return (
    <div className="schedule-page">
      <header className="schedule-header">
        <div>
          <h1 className="schedule-title">{t(locale, "liveSchedule.pageTitle")}</h1>
          <div className="schedule-subtitle">{t(locale, "liveSchedule.pageSubtitle")}</div>
        </div>

        <ScheduleToolbar
          locale={locale}
          weekStart={weekStart}
          creatorOptions={creatorOptions}
          selectedCreators={selectedCreators}
          onSelectedCreatorsChange={setSelectedCreators}
          organization={organization}
          onOrganizationChange={setOrganization}
        />
      </header>

      <ScheduleGrid locale={locale} days={days} now={now} selectedStreamId={selectedStream?.id ?? null} onSelectStream={setSelectedStream} />

      <StreamDetailModal
        stream={selectedStream}
        locale={locale}
        now={now}
        onClose={() => setSelectedStream(null)}
        onOpenStream={(stream) => {
          // flushSync: the player mounts (and, on a touch device, asks the browser for fullscreen while mounting) INSIDE this tap. The browser
          // only grants fullscreen from a user gesture, so it must not wait behind a batched or deferred state update.
          flushSync(() => {
            setSelectedStream(null)
            setEmbed({ videoId: stream.videoId, title: stream.title })
          })
        }}
        onSetReminder={(stream) => setReminderStream(stream)}
      />

      <StreamNotificationPanel stream={reminderStream} onClose={() => setReminderStream(null)} />

      {embed && <VideoPlayerModal videoId={embed.videoId} title={embed.title} variant="player-only" fullscreenOnOpen onClose={() => setEmbed(null)} />}
    </div>
  )
}
