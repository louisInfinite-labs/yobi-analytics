import { useRef, useState } from "react"
import { mockCreators } from "../../data/mockCreators"
import { homeAssetConfig } from "../../lib/homeAssets"
import { useSelectedCreator } from "../../hooks/useSelectedCreator"
import { CreatorStatusPanel } from "./CreatorStatusPanel"
import { DeskMonitor } from "./DeskMonitor"
import { HomeAnalyticsOverlay } from "./HomeAnalyticsOverlay"
import { OshiLayer } from "./OshiLayer"
import { RecentVideosSection } from "./RecentVideosSection"

/** One room-scene layer image (background/desk/chair/microphone/keyboard/
 * mouse) with a labeled placeholder fallback — the purchased ぱるぷんて。
 * asset files are not committed to this repo (see homeAssets.ts), so every
 * layer must degrade to something reviewable instead of a broken image. */
function RoomLayer({ src, label, className }: { src?: string; label: string; className: string }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return <div className={`home-scene__layer ${className} home-placeholder`}>{label}</div>
  }
  return (
    <img className={`home-scene__layer ${className}`} src={src} alt="" draggable={false} onError={() => setFailed(true)} />
  )
}

/** Home V1: a fixed 16:9 layered OBS-style scene inside the existing app
 * shell — Oshi left, analytics right, local media on the desk monitor
 * (spec's "Page Composition"/"Default Layout"). The Global Live Schedule
 * Dock (App.tsx-mounted, so it's visible on every page, not just this one)
 * and the YouTube embed overlay both reuse the existing VideoPlayerModal.
 *
 * Above the scene sits this session's own added "upper part", two columns:
 * left is RecentVideosSection (2 latest videos, then 2 livestream slots —
 * live-now + latest archive when one is live, otherwise the 2 latest
 * archives); right is CreatorStatusPanel ("ListStatus" — the selected
 * creator's name, and a collapsed live/offline-count summary that expands
 * into the same grouped list the global Dock shows). The whole page is
 * height-budgeted (see styles/home.css's `.home-page`) so this section plus
 * the scene together fit a 1920x1080 viewport without scrolling, per this
 * session's own explicit layout requirement. */
export function HomePage() {
  const [creatorId, setCreatorId] = useSelectedCreator()
  const [editable, setEditable] = useState(false)
  const sceneRef = useRef<HTMLDivElement>(null)

  return (
    <div className="home-page">
      <div className="home-page__toolbar">
        <label className="home-page__creator-picker">
          Oshi
          <select value={creatorId} onChange={(event) => setCreatorId(event.target.value)}>
            {mockCreators.map((creator) => (
              <option key={creator.channelId} value={creator.channelId}>
                {creator.channelName}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => setEditable((prev) => !prev)}>
          {editable ? "Done" : "Edit room"}
        </button>
      </div>

      <div className="home-page__upper">
        <RecentVideosSection creatorId={creatorId} />
        <CreatorStatusPanel creatorId={creatorId} />
      </div>

      <div className="home-scene" ref={sceneRef}>
        <RoomLayer src={homeAssetConfig.background} label="Room background" className="home-scene__background" />
        <RoomLayer src={homeAssetConfig.chair} label="Chair" className="home-scene__chair" />
        <OshiLayer creatorId={creatorId} sceneRef={sceneRef} editable={editable} />
        <RoomLayer src={homeAssetConfig.desk} label="Desk" className="home-scene__desk" />
        <DeskMonitor creatorId={creatorId} monitorRect={homeAssetConfig.monitorRect} editable={editable} />
        <RoomLayer src={homeAssetConfig.keyboard} label="Keyboard" className="home-scene__keyboard" />
        <RoomLayer src={homeAssetConfig.mouse} label="Mouse" className="home-scene__mouse" />
        <RoomLayer src={homeAssetConfig.microphone} label="Microphone" className="home-scene__microphone" />
        <HomeAnalyticsOverlay creatorId={creatorId} />
      </div>
    </div>
  )
}
