import { useState } from "react"
import { Modal } from "antd"
import { getScheduleCreatorAvatarVisual } from "../utils/creatorAvatar"
import { getScheduleCreatorName } from "../utils/scheduleCreatorName"
import { shouldShowLiveBadge, type ScheduledStream } from "../model/scheduledStream"
import { t, type Locale } from "../../../shared/i18n/translations"
import { streamStartText } from "../model/streamStartText"
import { useUpcomingDisplayMode } from "../../live-status/hooks/useUpcomingDisplayMode"
import { useTimeFormat } from "../../../shared/i18n/hooks/useTimeFormat"

interface StreamDetailModalProps {
  stream: ScheduledStream | null
  locale: Locale
  now: Date
  onClose: () => void
  onOpenStream: (stream: ScheduledStream) => void
  onSetReminder: (stream: ScheduledStream) => void
}

/** 16:9 real YouTube/Holodex thumbnail ratio (spec's own correction over an
 * earlier portrait-thumbnail concept), keyed by the stream's own real videoId. */
function StreamThumbnail({ stream, locale }: { stream: ScheduledStream; locale: Locale }) {
  const [thumbFailed, setThumbFailed] = useState(false)
  const isLive = stream.status === "live"
  const isPremiere = stream.status === "premiere"

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
      {isPremiere && <div className="thumbnail-premiere-badge">{t(locale, "liveSchedule.premiereBadge")}</div>}
    </div>
  )
}

export function StreamDetailModal({ stream, locale, now, onClose, onOpenStream, onSetReminder }: StreamDetailModalProps) {
  const [displayMode] = useUpcomingDisplayMode()
  const [timeFormat] = useTimeFormat()
  if (!stream) return null
  const creatorName = getScheduleCreatorName(stream.channelId)
  const visual = getScheduleCreatorAvatarVisual(stream.channelId, creatorName)
  const showLiveBadge = shouldShowLiveBadge(stream.status, stream.scheduledStartMs, now.getTime())
  const isLive = stream.status === "live"
  const isPremiere = stream.status === "premiere"
  const started = streamStartText(stream, locale, now.getTime(), displayMode, timeFormat)

  return (
    <Modal open onCancel={onClose} footer={null} centered width={820} rootClassName="stream-detail-dialog">
      <div className="stream-detail-content">
        <StreamThumbnail stream={stream} locale={locale} />

        <div className="stream-creator-header">
          <span className="creator-detail-avatar" style={visual.avatarUrl ? undefined : { background: visual.background, color: visual.color }}>
            {visual.avatarUrl ? <img src={visual.avatarUrl} alt="" /> : visual.initial}
          </span>

          <div className="creator-detail-identity">
            <div className="creator-detail-name">{creatorName}</div>
          </div>

          <div className="creator-live-state">
            {showLiveBadge && <span className="live-badge">{t(locale, "liveSchedule.liveBadge")}</span>}
            {isPremiere && <span className="premiere-badge">{t(locale, "liveSchedule.premiereBadge")}</span>}
            {started && <span className="started-time">{started}</span>}
          </div>
        </div>

        <h2 className="stream-detail-title">{stream.title}</h2>

        <div className="stream-modal-actions">
          {/* A stream that is already live has started, so a pre-stream reminder no longer applies. An upcoming Premiere offers the SAME button: it
              opens the reminder panel in its Premiere mode (the one-time Premiere reminder, a separate mechanism from the livestream reminders). */}
          {!isLive && (
            <button type="button" className="reminder-button" onClick={() => onSetReminder(stream)}>
              {t(locale, "liveSchedule.setReminderButton")}
            </button>
          )}
          <button type="button" className="open-stream-button" onClick={() => onOpenStream(stream)}>
            {t(locale, "liveSchedule.openStreamButton")}
          </button>
        </div>
      </div>
    </Modal>
  )
}
