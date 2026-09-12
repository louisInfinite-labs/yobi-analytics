import { useCallback, useMemo, useRef, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import type { RecentVideo } from "../../data/mockRecentVideos"
import { useRecentVideos } from "../../hooks/useRecentVideos"
import { selectLatestVideos, selectLivestreamSlots } from "../../lib/recentVideosSelection"
import { VideoPlayerModal } from "../VideoPlayerModal"

interface RecentVideosSectionProps {
  creatorId: string
}

/** Once the user has scrolled to roughly the 14th-16th card, the next page
 * is already worth fetching (this session: "user往右滑到14-16支影片時 再預入
 * 後20支影片") — picking the smaller end (14) means it fires no later than
 * that window. */
const PREFETCH_AT_INDEX = 13

const INITIAL_VISIBLE_COUNT = 20
/** Both how many more slots `visibleCount` grows by per prefetch AND how far
 * VideoRow's own next-prefetch threshold advances each time (see
 * nextThresholdRef below) — one page's worth either way. */
const VISIBLE_COUNT_STEP = 20

/** The card's own thumbnail sits above its title (this session: "幫我增加
 * youtube的播放器到每個標題的上方") using YouTube's own thumbnail JPG
 * endpoint — no separate fetch, keyed only by videoId. mockRecentVideos'
 * ids aren't real YouTube ids, so this degrades to the same dashed
 * placeholder look used elsewhere in Home rather than a broken image. */
function VideoThumbCard({ video, onOpen }: { video: RecentVideo; onOpen: (video: RecentVideo) => void }) {
  const [thumbFailed, setThumbFailed] = useState(false)
  const isLiveNow = video.contentFormat === "live_now"
  return (
    <button type="button" className="recent-videos__card" onClick={() => onOpen(video)}>
      <span className="recent-videos__thumb">
        {thumbFailed ? (
          <span className="home-placeholder recent-videos__thumb-placeholder">No thumbnail</span>
        ) : (
          <img
            className="recent-videos__thumb-image"
            src={`https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`}
            alt=""
            draggable={false}
            onError={() => setThumbFailed(true)}
          />
        )}
        {isLiveNow && <span className="recent-videos__live-badge">LIVE</span>}
      </span>
      <span className="recent-videos__title">{video.title}</span>
    </button>
  )
}

/** YouTube-style left/right chevron buttons flanking the scrollable
 * thumbnail track (this session: "影片的左右兩邊各加個箭頭ICON 可以滑動 ...
 * 可以找YOUTUBE 的風格"). They sit in normal flex flow rather than
 * overlaying the track, so the row's own left edge — where the left arrow
 * is — becomes the new left-alignment reference for home-scene above it
 * (this session: "靠左對齊改成 home scene 和 箭頭icon對齊"), not the
 * thumbnails themselves.
 *
 * `onNearEnd` fires once the leading visible card reaches
 * `nextThresholdRef` (starting at PREFETCH_AT_INDEX), which then advances
 * by VISIBLE_COUNT_STEP so the row keeps prefetching every ~20 cards as the
 * user keeps scrolling right, instead of firing once and never again
 * (CodeRabbit: a plain fired-boolean latch only resets by scrolling back
 * before card 14, so continuing to scroll forward past the first prefetch
 * never requested a third or later page). */
function VideoRow({
  label,
  videos,
  emptyLabel,
  onOpen,
  onNearEnd,
}: {
  label: string
  videos: RecentVideo[]
  emptyLabel: string
  onOpen: (video: RecentVideo) => void
  onNearEnd: () => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const nextThresholdRef = useRef(PREFETCH_AT_INDEX)
  // Left arrow starts hidden -- the track starts scrolled all the way left
  // (list[0] flush against the left edge), so there's nothing left to
  // scroll back to yet (this session: "＜箭頭顯示是條件是目前list[0]的影片
  // 不在最左邊"). Any rightward scroll at all reveals it again ("有被滑了
  //一下也要顯示"), not just once it's scrolled a full card.
  const [canScrollLeft, setCanScrollLeft] = useState(false)

  function scrollByOneCard(direction: 1 | -1) {
    const track = trackRef.current
    if (!track) return
    const card = track.querySelector<HTMLElement>(".recent-videos__card")
    const step = card ? card.offsetWidth + 12 : track.clientWidth * 0.8
    track.scrollBy({ left: direction * step, behavior: "smooth" })
  }

  function handleScroll() {
    const track = trackRef.current
    if (!track) return
    setCanScrollLeft(track.scrollLeft > 0)

    const card = track.querySelector<HTMLElement>(".recent-videos__card")
    if (!card) return
    const cardStep = card.offsetWidth + 12
    const leadingIndex = Math.floor(track.scrollLeft / cardStep)

    if (leadingIndex >= nextThresholdRef.current) {
      nextThresholdRef.current += VISIBLE_COUNT_STEP
      onNearEnd()
    }
  }

  return (
    <div className="recent-videos__section">
      <div className="recent-videos__label">{label}</div>
      <div className="recent-videos__row">
        <button
          type="button"
          className={`recent-videos__scroll-button${canScrollLeft ? "" : " recent-videos__scroll-button--hidden"}`}
          onClick={() => scrollByOneCard(-1)}
          aria-label={`Scroll ${label} left`}
        >
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <div ref={trackRef} className="recent-videos__track" onScroll={handleScroll}>
          {videos.length === 0 ? (
            <div className="recent-videos__empty">{emptyLabel}</div>
          ) : (
            videos.map((video) => <VideoThumbCard key={video.videoId} video={video} onOpen={onOpen} />)
          )}
        </div>
        <button
          type="button"
          className="recent-videos__scroll-button"
          onClick={() => scrollByOneCard(1)}
          aria-label={`Scroll ${label} right`}
        >
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

/** Home's upper section (this session's own spec): latest normal videos,
 * a gap, then livestream slots — currently-live + most recent completed
 * streams when one is live now, otherwise the most recent completed
 * streams. Both rows start with 20 slots and grow by another 20 (up to
 * however many that row's own underlying video pool actually holds) once
 * the user scrolls into ITS OWN 14th-16th card (this session: "先加載好
 * 20+20 ... 滑到14-16支時 再預入後20支" / "user 滑動 最新直播時 ... 只會再
 * 發生api request 取 更多的最新直播 最新影片的判定不會被觸發") — each row
 * has its own visibleCount and its own useRecentVideos pool/loadMore, so
 * scrolling one row never fetches or reveals more of the other.
 *
 * Sits above the room scene, not one of its layers, since a thumbnail/list
 * UI doesn't belong inside the OBS-style composition. */
export function RecentVideosSection({ creatorId }: RecentVideosSectionProps) {
  const [embed, setEmbed] = useState<RecentVideo | null>(null)
  const [latestVisibleCount, setLatestVisibleCount] = useState(INITIAL_VISIBLE_COUNT)
  const [streamVisibleCount, setStreamVisibleCount] = useState(INITIAL_VISIBLE_COUNT)
  const { latestVideos: latestPool, streamVideos: streamPool } = useRecentVideos(creatorId)

  const latestVideos = useMemo(
    () => selectLatestVideos(latestPool.videos, latestVisibleCount),
    [latestPool.videos, latestVisibleCount],
  )
  const livestreamSlots = useMemo(
    () => selectLivestreamSlots(streamPool.videos, streamVisibleCount),
    [streamPool.videos, streamVisibleCount],
  )

  const handleLatestNearEnd = useCallback(() => {
    setLatestVisibleCount((prev) => prev + VISIBLE_COUNT_STEP)
    latestPool.loadMore()
  }, [latestPool])

  const handleStreamNearEnd = useCallback(() => {
    setStreamVisibleCount((prev) => prev + VISIBLE_COUNT_STEP)
    streamPool.loadMore()
  }, [streamPool])

  return (
    <div className="recent-videos">
      <VideoRow label="最新影片" videos={latestVideos} emptyLabel="No recent videos" onOpen={setEmbed} onNearEnd={handleLatestNearEnd} />
      <VideoRow label="最新直播" videos={livestreamSlots} emptyLabel="No recent streams" onOpen={setEmbed} onNearEnd={handleStreamNearEnd} />
      {embed && <VideoPlayerModal videoId={embed.videoId} title={embed.title} onClose={() => setEmbed(null)} />}
    </div>
  )
}
