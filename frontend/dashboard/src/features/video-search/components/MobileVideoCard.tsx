import { useState } from "react"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import { t, type Locale } from "../../../shared/i18n/translations"
import { formatCardMeta } from "../../home-room/utils/videoCardMeta"

/** A full-width row card for the mobile Videos list -- reuses .oshi-video-card's own existing visual
 * treatment (thumbnail, title, meta text; home.css) exactly, only arranged horizontally instead of
 * Home's vertical shelf card (see videoSearch.css's `.mobile-videos__list .oshi-video-card` layout-only
 * override). Deliberately simpler than Home's VideoThumbCard: no mouse-drag-to-scroll suppression logic
 * is needed in a plain vertical list. */
export function MobileVideoCard({ video, locale, onOpen }: { video: RecentVideo; locale: Locale; onOpen: () => void }) {
  const [thumbFailed, setThumbFailed] = useState(false)
  const isLiveNow = video.contentFormat === "live_now"
  const meta = formatCardMeta(video)

  return (
    <button type="button" className="oshi-video-card" onClick={onOpen}>
      <span className="oshi-video-card__thumbnail">
        {thumbFailed ? (
          <span className="home-placeholder">No thumbnail</span>
        ) : (
          <img src={`https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`} alt="" draggable={false} onError={() => setThumbFailed(true)} />
        )}
        {isLiveNow && <span className="oshi-video-card__live-badge">{t(locale, "recentVideos.liveBadge")}</span>}
      </span>
      <span className="oshi-video-card__body">
        <span className="oshi-video-card__title">{video.title}</span>
        {meta && <span className="oshi-video-card__meta">{meta}</span>}
      </span>
    </button>
  )
}
