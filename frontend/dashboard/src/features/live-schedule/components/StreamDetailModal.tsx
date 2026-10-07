import { useState } from "react"
import { Modal } from "antd"
import { getScheduleCreatorAvatarVisual } from "../utils/creatorAvatar"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { shouldShowLiveBadge, type ScheduledStream } from "../model/scheduledStream"
import { t, type Locale } from "../../../shared/i18n/translations"
import { formatCountdown } from "../../live-status/model/creatorStatusFormat"

const creatorsById = new Map(mockCreators.map((creator) => [creator.channelId, creator]))

interface StreamDetailModalProps {
  stream: ScheduledStream | null
  locale: Locale
  now: Date
  onClose: () => void
  onOpenStream: (stream: ScheduledStream) => void
  onSetReminder: (stream: ScheduledStream) => void
}

/** "Starts in ..." reuses creatorStatusFormat's shared countdown formatter
 * (already used by Home/Live Status for this exact kind of display) instead
 * of this file's own former plain-minutes duplicate. "Started ... ago" has
 * no shared equivalent to reuse, so that branch's calculation is unchanged. */
function startedTimeText(stream: ScheduledStream, locale: Locale, nowMs: number): string | null {
  if (stream.status === "ended") return null
  if (stream.status === "live") {
    const minutes = Math.max(0, Math.round(Math.abs(nowMs - stream.scheduledStartMs) / 60_000))
    return t(locale, "liveSchedule.startedMinutesAgo", { minutes: String(minutes) })
  }
  return formatCountdown(new Date(stream.scheduledStartMs).toISOString(), new Date(nowMs), locale)
}

/** 16:9 real YouTube/Holodex thumbnail ratio (spec's own correction over an
 * earlier portrait-thumbnail concept), keyed by the stream's own real videoId. */
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
          src={`https://img.youtube.com/vi/${stream.videoId}/hqdefault.jpg`}
          alt=""
          onError={() => setThumbFailed(true)}
        />
      )}
      {isLive && <div className="thumbnail-live-badge">{t(locale, "liveSchedule.liveBadge")}</div>}
    </div>
  )
}

export function StreamDetailModal({ stream, locale, now, onClose, onOpenStream, onSetReminder }: StreamDetailModalProps) {
  if (!stream) return null
  const creator = creatorsById.get(stream.channelId)
  const visual = getScheduleCreatorAvatarVisual(stream.channelId, creator?.channelName ?? stream.channelId)
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
          <button type="button" className="reminder-button" onClick={() => onSetReminder(stream)}>
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
