import { useEffect, useState } from "react"
import { Avatar } from "antd"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { OshiErrorState } from "../../home-room/components/OshiErrorState"
import { getMemberAccent } from "../../../shared/theme/memberAccent"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { useTimeFormat } from "../../../shared/i18n/hooks/useTimeFormat"
import { t, type Locale } from "../../../shared/i18n/translations"
import type { TimeFormat } from "../../../shared/i18n/model/timeFormat"
import { formatUpcomingStart } from "../../live-status/model/creatorStatusFormat"
import { useUpcomingDisplayMode } from "../../live-status/hooks/useUpcomingDisplayMode"
import { resolveCreatorKey } from "../../../entities/creator/data/creatorRegistry"
import { resetPreviousVisit, usePreviousVisit } from "../hooks/useLastVisit"
import { useOshiStatus } from "../hooks/useOshiStatus"
import type { HomeAllFeed } from "../../home-room/hooks/useHomeAllFeed"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import { countUnwatched, formatActivityTime, formatCompactCount } from "../utils/oshiActivity"
import { markContentSeen, migrateWatchedLiveToSeen, resetNewContentTracking, useNewContent } from "../../../shared/newContent/newContentTracking"
import type { CreatorStatus } from "../../live-status/model/creatorStatus"

/** Shown for any number the backend has not provided (still loading, the request failed, or no
 * value exists for it) -- never a fabricated 0. */
const VALUE_UNAVAILABLE = "—"

/** Home's Latest Activity shows only the FIRST 6 items of the shared ALL dataset -- a preview, never paged. The Video List is where the full
 * list (and its 20-per-page infinite scroll) lives. The 尚未觀看 counts below are NOT limited by this. */
export const LATEST_ACTIVITY_ROW_LIMIT = 6

interface OshiStatusPanelProps {
  creatorId: string
  status: CreatorStatus
  /** Home's ONE shared ALL dataset (see useHomeAllFeed): Latest Activity shows its FIRST 6 items in the order Video List ALL lists
   * them, and the 尚未觀看 counts cover the whole list -- it owns no data of its own, makes no request of its own and never pages. */
  feed: HomeAllFeed
  now: Date
  /** The one shared Home selected-video path (see HomePage.tsx) -- switches
   * the central Oshi Stream player directly, never a modal/second player. */
  onSelectVideo: (video: { videoId: string; title: string }) => void
  /** The CURRENT central Oshi Stream player's video title (HomePage.tsx's own
   * `embed?.title`), never the live/upcoming stream title (`status.title`,
   * shown separately in Live/Next below) -- those are different concepts
   * that happen to often match. Null when nothing is loaded in the player. */
  nowPlayingTitle: string | null
  /** The videoId of that same player video, so its thumbnail can be shown. Optional: without it no thumbnail is shown. */
  nowPlayingVideoId?: string | null
}

/** The existing app-wide thumbnail path for a video with no backend `thumbnailUrl` (Home's cards, the Schedule modal and the old Recent
 * Activity thumbnail all key YouTube's own JPG endpoint by the real videoId) -- never a substituted video. */
function fallbackThumbnailUrl(videoId: string): string {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
}

/** A 16:9 video thumbnail (377px wide on desktop, scaling down with the panel, never distorted: object-fit cover). Source order: the
 * backend's own thumbnail field, then the app's videoId-keyed fallback, then a neutral 16:9 placeholder -- no other request is made.
 * Always a button that runs the SAME handler as the item's title (Now Playing, Live, Next and every Recent Activity row), so no thumbnail
 * in the panel looks interactive while doing nothing. */
function StatusThumbnail({
  videoId,
  thumbnailUrl,
  label,
  onOpen,
}: {
  videoId: string
  thumbnailUrl?: string | null
  label: string
  onOpen: () => void
}) {
  const [locale] = useLocale()
  // A distinct accessible name: the title button beside it already carries the plain title, and two controls must not share one name.
  const accessibleName = t(locale, "oshiStatus.thumbnailLabel", { title: label })
  const sources = [thumbnailUrl || null, fallbackThumbnailUrl(videoId)].filter((url): url is string => Boolean(url))
  // How many of this video's sources have failed to load; past the end -> the placeholder.
  const [failed, setFailed] = useState<{ videoId: string; count: number }>({ videoId, count: 0 })
  const attempt = failed.videoId === videoId ? failed.count : 0
  const src = sources[attempt]
  const image = src ? (
    <img key={src} src={src} alt="" draggable={false} onError={() => setFailed({ videoId, count: attempt + 1 })} />
  ) : (
    <span className="oshi-status__thumb-placeholder">{t(locale, "liveSchedule.noThumbnail")}</span>
  )

  return (
    <button type="button" className="oshi-status__thumb" aria-label={accessibleName} onClick={onOpen}>
      {image}
    </button>
  )
}

/** One Recent Activity row: [time + NEW] [clickable title] on the first line, the full-width thumbnail below
 * -- see home.css's own .oshi-status__recent-row. NEW lives under the timestamp specifically so
 * it can never eat into the title's own width; every entry here is a real backend video with a videoId,
 * so the title and the thumbnail are always clickable. */
function RecentActivityRow({
  entry,
  now,
  locale,
  timeFormat,
  onOpen,
}: {
  entry: RecentVideo
  now: Date
  locale: Locale
  timeFormat: TimeFormat
  onOpen: (video: { videoId: string; title: string }) => void
}) {
  // NEW is displayed only here. The seen state (keyed by videoId) is shared with Home's Video List, which shows no badge: opening an
  // eligible archive or upload in either list calls markContentSeen; live/upcoming clicks do not. A confirmed PLAYING of a live stream
  // also keeps its later archive from being NEW (see newContentTracking.ts).
  const { isNew: isNewContent } = useNewContent()
  const isNew = isNewContent(
    { videoId: entry.videoId, publishedAt: entry.publishedAt, eventAt: entry.eventAt, discoveredAt: entry.discoveredAt, contentFormat: entry.contentFormat },
    now,
  )
  const isCurrentStream = entry.contentFormat === "live_now" || entry.contentFormat === "live_upcoming"
  // One handler for the title AND the thumbnail, so they can never diverge (same seen-marking, same selected video). A live/upcoming
  // row never counts as opened by itself (HomePage's openVideo decides), exactly like the same stream in the Video List.
  const open = () => {
    if (!isCurrentStream) markContentSeen(entry.videoId)
    onOpen({ videoId: entry.videoId, title: entry.title })
  }

  return (
    <div className="oshi-status__recent-row">
      <div className="oshi-status__recent-time-column">
        <span className="oshi-status__recent-time">{formatActivityTime(entry.eventAt ?? entry.publishedAt, now, timeFormat)}</span>
        {isNew && <span className="oshi-status__recent-new-badge">{t(locale, "oshiStatus.newBadge")}</span>}
      </div>
      <div className="oshi-status__recent-content">
        <button
          type="button"
          className="oshi-status__recent-video-link"
          onClick={open}
        >
          {entry.title}
        </button>
      </div>
      <StatusThumbnail videoId={entry.videoId} thumbnailUrl={entry.thumbnailUrl} label={entry.title} onOpen={open} />
    </div>
  )
}

/** One value/label pair in the compact 3-column metric rows -- `value` is a
 * pre-formatted string (already localized/compacted by the caller) since
 * this component has no numeric or locale knowledge of its own. */
function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="oshi-status__metric">
      <div className="oshi-status__metric-value">{value}</div>
      <div className="oshi-status__metric-label">{label}</div>
    </div>
  )
}

/** LIVE now, else the nearest upcoming stream, else nothing scheduled. The upcoming start is shown the way the user's one global
 * "upcoming time display" setting says (clock time in the 12h/24h format, or the countdown) -- the same formatter the Live Status dock and
 * the Schedule page use, so one stream reads the same everywhere. */
function LiveOrNext({ status, now, onOpen }: { status: CreatorStatus; now: Date; onOpen: (video: { videoId: string; title: string }) => void }) {
  const [locale] = useLocale()
  const [timeFormat] = useTimeFormat()
  const [displayMode] = useUpcomingDisplayMode()

  if (status.kind === "offline") {
    return <div className="oshi-empty-state">{t(locale, "oshiStatus.noScheduledStream")}</div>
  }
  // The title and the thumbnail run this one handler (a live/upcoming pick never counts as watched by itself -- HomePage's openVideo decides).
  const open = status.videoId ? () => onOpen({ videoId: status.videoId, title: status.title }) : undefined
  return (
    <div className="oshi-status__next">
      <div className="oshi-status__next-main">
        <div className="oshi-status__next-time">
          {status.kind === "live" ? t(locale, "oshiStatus.liveNow") : formatUpcomingStart(status.scheduledStart, displayMode, now, locale, timeFormat)}
        </div>
        {/* The CURRENT LIVE title and the nearest UPCOMING title both open that exact stream, with the status's own videoId and
          * the same onOpen handler the recent rows use -- no title search, no navigation to the recent list. A status
          * without a usable videoId stays plain text. */}
        {open ? (
          <button type="button" className="oshi-status__next-title oshi-status__next-title--link" onClick={open}>
            {status.title}
          </button>
        ) : (
          <div className="oshi-status__next-title">{status.title}</div>
        )}
      </div>
      {open && (
        <div className="oshi-status__next-thumb">
          <StatusThumbnail videoId={status.videoId} thumbnailUrl={status.thumbnailUrl} label={status.title} onOpen={open} />
        </div>
      )}
    </div>
  )
}

/** Home's compact right-hand panel: who the current Oshi is, what they're
 * streaming, what is still unwatched (the NEW items of Recent Activity), and this week's activity.
 * Live/Next comes from the shared Holodex status; everything else (subscriber count,
 * since-last-visit and this-week counts, view growth, the recent rows) is the backend's
 * GET /creators/{creatorId}/oshi-status read model for the CURRENT creator. */
export function OshiStatusPanel({ creatorId, status, feed, now, onSelectVideo, nowPlayingTitle, nowPlayingVideoId = null }: OshiStatusPanelProps) {
  const creator = mockCreators.find((entry) => entry.channelId === creatorId)
  // The channel icon is the canonical Creator Registry's `avatarUrl` (the backend Creator Master's YouTube channel icon); the mock roster
  // above never carries one, so reading it from there always fell back to the initial.
  const registryAvatarUrl = resolveCreatorKey(creatorId)?.avatarUrl ?? undefined
  // Which icon URL failed to load, so the initial (with the creator-colored circle) shows only for that URL, and a different creator is tried again.
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null)
  const avatarUrl = registryAvatarUrl && registryAvatarUrl !== failedAvatarUrl ? registryAvatarUrl : undefined
  const accent = getMemberAccent(creatorId, resolveCreatorKey(creatorId)?.themeColor)
  const previousVisit = usePreviousVisit()
  const [locale] = useLocale()
  const [timeFormat] = useTimeFormat()
  const { data } = useOshiStatus(resolveCreatorKey(creatorId)?.creatorId, previousVisit)
  const { videos: recent, loading, error } = feed
  const latestRows = recent.slice(0, LATEST_ACTIVITY_ROW_LIMIT)
  // The now-playing video's backend thumbnail, when this panel already holds one for that videoId (the live/upcoming status or a recent row).
  const nowPlayingThumbnail =
    nowPlayingVideoId === null
      ? undefined
      : status.kind !== "offline" && status.videoId === nowPlayingVideoId
        ? status.thumbnailUrl
        : recent.find((entry) => entry.videoId === nowPlayingVideoId)?.thumbnailUrl
  // A stream watched while live that shows up here as a COMPLETED archive row is now an archive, so its marker becomes a permanent seen entry.
  useEffect(() => {
    migrateWatchedLiveToSeen(recent.filter((item) => item.contentFormat === "live_archive").map((item) => item.videoId))
  }, [recent])
  const openNowPlaying = nowPlayingVideoId && nowPlayingTitle ? () => onSelectVideo({ videoId: nowPlayingVideoId, title: nowPlayingTitle }) : undefined
  const number = (value: number | undefined) => (value === undefined ? VALUE_UNAVAILABLE : String(value))
  // 尚未觀看: the SAME NEW judgement the Recent Activity rows draw their NEW badge from (the shared seen/baseline state, never the last-visit
  // time or a second unread system), over EVERY eligible record of the whole ALL list -- not the 6 rows shown here, not the pages loaded in the
  // Video List. Opening an item anywhere marks it seen in the shared store, which re-renders every badge and this count at once.
  // Unavailable (not 0) until the list loads or when the backend did not supply the eligibility. The backend's eligibility is exact and uncapped.
  const { isNew: isNewContent, isUnseen } = useNewContent()
  const eligibility = feed.newContent
  const rowsAvailable = !loading && !error && eligibility !== undefined
  const unwatched = countUnwatched(eligibility, recent, { isNew: isNewContent, isUnseen }, now)
  const countLabel = (value: number) => String(value)

  return (
    <aside className="oshi-status">
      <div className="oshi-status__header">
        <div className="oshi-status__header-top">
          <div className="oshi-status__creator">
            <Avatar
              size={36}
              src={avatarUrl}
              alt={creator?.channelName ?? creatorId}
              className="oshi-status__creator-avatar"
              onError={() => {
                setFailedAvatarUrl(registryAvatarUrl ?? null)
                return true
              }}
              style={avatarUrl ? undefined : { background: accent.primary, color: accent.textAccent }}
            >
              {creator?.channelName.charAt(0)}
            </Avatar>
            <div className="oshi-status__creator-text">
              <div className="oshi-status__creator-name">{creator?.channelName ?? creatorId}</div>
              {/* The backend's subscriberCount; the line is omitted when it is null (never a fabricated 0). */}
              {data?.subscriberCount != null && (
                <div className="oshi-status__subscriber-count">
                  {formatCompactCount(data.subscriberCount)} {t(locale, "oshiStatus.subscribers")}
                </div>
              )}
            </div>
          </div>
          {import.meta.env.DEV && (
            <button
              type="button"
              className="oshi-status__dev-reset"
              onClick={() => {
                resetNewContentTracking()
                resetPreviousVisit()
              }}
            >
              {t(locale, "oshiStatus.devResetVisit")}
            </button>
          )}
        </div>
        {nowPlayingTitle && (
          <div className="oshi-status__now-playing">
            <div className="oshi-status__now-playing-label">{t(locale, "oshiStatus.nowPlaying")}</div>
            {/* With a videoId, the title and the thumbnail run the one shared selection path (select, then back to the player), like every
              * other title/thumbnail pair in this panel. Without one (only a title is known) there is nothing to select: plain text. */}
            {openNowPlaying ? (
              <button type="button" className="oshi-status__now-playing-title oshi-status__now-playing-title--link" onClick={openNowPlaying}>
                {nowPlayingTitle}
              </button>
            ) : (
              <div className="oshi-status__now-playing-title">{nowPlayingTitle}</div>
            )}
            {nowPlayingVideoId && openNowPlaying && (
              <div className="oshi-status__now-playing-thumb">
                <StatusThumbnail videoId={nowPlayingVideoId} thumbnailUrl={nowPlayingThumbnail} label={nowPlayingTitle} onOpen={openNowPlaying} />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="oshi-status__body">
        <section className="oshi-status__section">
          <div className="oshi-status__section-title">{t(locale, "oshiStatus.liveNext")}</div>
          <LiveOrNext status={status} now={now} onOpen={onSelectVideo} />
        </section>

        <section className="oshi-status__section">
          <div className="oshi-status__section-title">{t(locale, "oshiStatus.unseen")}</div>
          <div className="oshi-status__metrics">
            <Metric value={rowsAvailable ? countLabel(unwatched.videos) : VALUE_UNAVAILABLE} label={t(locale, "oshiStatus.unseenVideos")} />
            <Metric value={rowsAvailable ? countLabel(unwatched.livestreams) : VALUE_UNAVAILABLE} label={t(locale, "oshiStatus.unseenLive")} />
          </div>
        </section>

        <section className="oshi-status__section">
          <div className="oshi-status__section-title">{t(locale, "oshiStatus.thisWeek")}</div>
          <div className="oshi-status__metrics">
            <Metric value={number(data?.thisWeek.newStreams)} label={t(locale, "oshiStatus.streams")} />
            <Metric value={number(data?.thisWeek.newUploads)} label={t(locale, "oshiStatus.uploads")} />
          </div>
        </section>

        <section className="oshi-status__section oshi-status__section--recent">
          <div className="oshi-status__section-title">{t(locale, "oshiStatus.recent")}</div>
          {loading ? (
            <div className="oshi-status__recent-list">
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className="oshi-status__recent-row">
                  <span className="oshi-loading-line" style={{ height: 9, width: 34 }} />
                  <span className="oshi-loading-line" style={{ height: 9 }} />
                  <span className="oshi-loading-line oshi-status__thumb-skeleton" />
                </div>
              ))}
            </div>
          ) : error ? (
            <OshiErrorState error={error} />
          ) : latestRows.length === 0 ? (
            <div className="oshi-empty-state">{t(locale, "oshiStatus.noRecentActivity")}</div>
          ) : (
            <div className="oshi-status__recent-list">
              {latestRows.map((entry) => (
                <RecentActivityRow
                  key={entry.videoId}
                  entry={entry}
                  now={now}
                  locale={locale}
                  timeFormat={timeFormat}
                  onOpen={onSelectVideo}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}
