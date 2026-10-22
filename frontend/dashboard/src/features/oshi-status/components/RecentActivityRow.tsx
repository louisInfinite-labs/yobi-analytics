import { useState } from "react"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t, type Locale } from "../../../shared/i18n/translations"
import type { TimeFormat } from "../../../shared/i18n/model/timeFormat"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import { formatActivityTime } from "../utils/oshiActivity"
import { markContentSeen, useNewContent } from "../../../shared/newContent/newContentTracking"

/** The existing app-wide thumbnail path for a video with no backend `thumbnailUrl` (Home's cards, the Schedule modal and the old Recent
 * Activity thumbnail all key YouTube's own JPG endpoint by the real videoId) -- never a substituted video. */
function fallbackThumbnailUrl(videoId: string): string {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
}

/** A 16:9 video thumbnail (377px wide on desktop, scaling down with the panel, never distorted: object-fit cover). Source order: the
 * backend's own thumbnail field, then the app's videoId-keyed fallback, then a neutral 16:9 placeholder -- no other request is made.
 * Always a button that runs the SAME handler as the item's title (Now Playing, Live, Next and every Recent Activity row), so no thumbnail
 * in the panel looks interactive while doing nothing. */
export function StatusThumbnail({
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
export function RecentActivityRow({
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
  // A Premiere is not a livestream, but like one it has not happened yet: opening its waiting page is not watching it. A pending-archive
  // placeholder (ended, archive not yet verified) is not confirmed watchable either -- opening it must not mark the eventual real archive seen.
  const isNotYetWatchable =
    entry.contentFormat === "live_now" ||
    entry.contentFormat === "live_upcoming" ||
    entry.contentFormat === "premiere" ||
    entry.contentFormat === "archive_pending"
  // One handler for the title AND the thumbnail, so they can never diverge (same seen-marking, same selected video). A live/upcoming or
  // Premiere row never counts as opened by itself (HomePage's openVideo decides), exactly like the same stream in the Video List.
  const open = () => {
    if (!isNotYetWatchable) markContentSeen(entry.videoId)
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
