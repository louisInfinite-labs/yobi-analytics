import { useState } from "react"
import { Modal } from "antd"
import { getCreatorAvatarVisual } from "../../analytics/charts/CreatorAvatar"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { resolvePlaybackVideoId } from "../../home-room/data/mockRecentVideos"
import { shouldShowLiveBadge, type ScheduledStream } from "../model/scheduledStream"
import { t, type Locale } from "../../../shared/i18n/translations"

const creatorsById = new Map(mockCreators.map((creator) => [creator.channelId, creator]))

interface StreamDetailModalProps {
  stream: ScheduledStream | null
  locale: Locale
  now: Date
  onClose: () => void
  onOpenStream: (stream: ScheduledStream) => void
}

function startedTimeText(stream: ScheduledStream, locale: Locale, nowMs: number): string | null {
  if (stream.status === "ended") return null
  const minutes = Math.max(0, Math.round(Math.abs(nowMs - stream.scheduledStartMs) / 60_000))
  return stream.status === "live"
    ? t(locale, "liveSchedule.startedMinutesAgo", { minutes: String(minutes) })
    : t(locale, "liveSchedule.startsInMinutes", { minutes: String(minutes) })
}

/** 16:9 real YouTube/Holodex thumbnail ratio (spec's own correction over an
 * earlier portrait-thumbnail concept) -- resolvePlaybackVideoId's fallback to
 * an always-embeddable demo id is what mockRecentVideos.ts's own docstring
 * documents for non-real videoIds, same as RecentVideosSection's thumbnail. */
function StreamThumbnail({ stream, locale }: { stream: ScheduledStream; locale: Locale }) {
  const [thumbFailed, setThumbFailed] = useState(false)
  const isLive = stream.status === "live"

  return (
    <div className="stream-detail-thumbnail-wrap">
      {thumbFailed ? (
        <span className="schedule-thumbnail-placeholder">{t(locale, "liveSchedule.noThumbnail")}</span>
      ) : (
        <img
          className="stream-detail-thumbnail"
          src={`https://img.youtube.com/vi/${resolvePlaybackVideoId(stream.videoId)}/hqdefault.jpg`}
          alt=""
          onError={() => setThumbFailed(true)}
        />
      )}
      {isLive && <div className="thumbnail-live-badge">{t(locale, "liveSchedule.liveBadge")}</div>}
    </div>
  )
}

export function StreamDetailModal({ stream, locale, now, onClose, onOpenStream }: StreamDetailModalProps) {
  if (!stream) return null
  const creator = creatorsById.get(stream.channelId)
  const visual = getCreatorAvatarVisual(stream.channelId, creator?.channelName ?? stream.channelId)
  const showLiveBadge = shouldShowLiveBadge(stream.status, stream.scheduledStartMs, now.getTime())
  const started = startedTimeText(stream, locale, now.getTime())

  return (
    <Modal open onCancel={onClose} footer={null} centered width={820} rootClassName="stream-detail-dialog">
      <div className="stream-detail-content">
        <StreamThumbnail stream={stream} locale={locale} />

        <div className="stream-creator-header">
          <span className="creator-detail-avatar" style={visual.avatarUrl ? undefined : { background: visual.background, color: visual.color }}>
            {visual.avatarUrl ? <img src={visual.avatarUrl} alt="" /> : visual.initial}
          </span>

          <div className="creator-detail-identity">
            <div className="creator-detail-name">{creator?.channelName ?? stream.channelId}</div>
          </div>

          <div className="creator-live-state">
            {showLiveBadge && <span className="live-badge">{t(locale, "liveSchedule.liveBadge")}</span>}
            {started && <span className="started-time">{started}</span>}
          </div>
        </div>

        <h2 className="stream-detail-title">{stream.title}</h2>

        <div className="stream-modal-actions">
          <button type="button" className="reminder-button" disabled>
            {t(locale, "liveSchedule.setReminderButton")}
          </button>
          <button type="button" className="open-stream-button" onClick={() => onOpenStream(stream)}>
            {t(locale, "liveSchedule.openStreamButton")}
          </button>
        </div>
      </div>
    </Modal>
  )
}
