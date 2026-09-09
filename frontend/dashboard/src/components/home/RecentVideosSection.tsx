import { useMemo, useState } from "react"
import { getRecentVideosForCreator, type RecentVideo } from "../../data/mockRecentVideos"
import { selectLatestVideos, selectLivestreamSlots } from "../../lib/recentVideosSelection"
import { VideoPlayerModal } from "../VideoPlayerModal"

interface RecentVideosSectionProps {
  creatorId: string
}

function VideoThumbCard({ video, onOpen }: { video: RecentVideo; onOpen: (video: RecentVideo) => void }) {
  const isLiveNow = video.contentFormat === "live_now"
  return (
    <button type="button" className="recent-videos__card" onClick={() => onOpen(video)}>
      <span className="recent-videos__thumb">
        {isLiveNow && <span className="recent-videos__live-badge">LIVE</span>}
      </span>
      <span className="recent-videos__title">{video.title}</span>
    </button>
  )
}

function VideoRow({
  label,
  videos,
  emptyLabel,
  onOpen,
}: {
  label: string
  videos: RecentVideo[]
  emptyLabel: string
  onOpen: (video: RecentVideo) => void
}) {
  return (
    <div className="recent-videos__section">
      <div className="recent-videos__label">{label}</div>
      <div className="recent-videos__row">
        {videos.length === 0 ? (
          <div className="recent-videos__empty">{emptyLabel}</div>
        ) : (
          videos.map((video) => <VideoThumbCard key={video.videoId} video={video} onOpen={onOpen} />)
        )}
      </div>
    </div>
  )
}

/** Home's upper section (this session's own spec): 2 latest normal videos,
 * a gap, then 2 livestream slots — currently-live + most recent archive
 * when a stream is live now, otherwise the 2 most recent archives. Sits
 * above the room scene, not one of its layers, since a thumbnail/list UI
 * doesn't belong inside the OBS-style composition. Backed by mockRecentVideos.ts
 * — see that file's own docstring for the real-data swap point. */
export function RecentVideosSection({ creatorId }: RecentVideosSectionProps) {
  const [embed, setEmbed] = useState<RecentVideo | null>(null)
  const videos = useMemo(() => getRecentVideosForCreator(creatorId), [creatorId])
  const latestVideos = useMemo(() => selectLatestVideos(videos), [videos])
  const livestreamSlots = useMemo(() => selectLivestreamSlots(videos), [videos])

  return (
    <div className="recent-videos">
      <VideoRow label="最新影片" videos={latestVideos} emptyLabel="No recent videos" onOpen={setEmbed} />
      <VideoRow label="最新直播" videos={livestreamSlots} emptyLabel="No recent streams" onOpen={setEmbed} />
      {embed && <VideoPlayerModal videoId={embed.videoId} title={embed.title} onClose={() => setEmbed(null)} />}
    </div>
  )
}
