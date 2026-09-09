import { useRef } from "react"
import type { HomeRect } from "../../lib/homeAssets"
import { useDeskMedia } from "../../hooks/useDeskMedia"

interface DeskMonitorProps {
  creatorId: string
  monitorRect: HomeRect
  editable: boolean
}

/** Layer 3: one local media item (image/GIF/MP4/WebM) per creator, rendered
 * on the desk monitor and restored on load/creator-change (spec section
 * "Small Desk Monitor / Local Media"). */
export function DeskMonitor({ creatorId, monitorRect, editable }: DeskMonitorProps) {
  const { settings, mediaUrl, loading, upload, remove, setFitMode, setMuted } = useDeskMedia(creatorId)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const style = {
    left: `${monitorRect.xPercent}%`,
    top: `${monitorRect.yPercent}%`,
    width: `${monitorRect.widthPercent}%`,
    height: `${monitorRect.heightPercent}%`,
  }

  return (
    <div className="home-scene__layer home-desk-monitor" style={style}>
      {loading ? null : mediaUrl && settings.mediaKind === "video" ? (
        <video
          className="home-desk-monitor__media"
          src={mediaUrl}
          style={{ objectFit: settings.fitMode }}
          muted={settings.muted}
          loop
          autoPlay
          playsInline
          onError={(event) => {
            // Autoplay/decoding can fail silently in some browsers/contexts —
            // fall back to a static placeholder rather than a broken frame.
            ;(event.currentTarget as HTMLVideoElement).style.display = "none"
          }}
        />
      ) : mediaUrl ? (
        <img className="home-desk-monitor__media" src={mediaUrl} alt="" style={{ objectFit: settings.fitMode }} />
      ) : (
        <div className="home-placeholder home-placeholder--monitor">No local media</div>
      )}

      {editable && (
        <div className="home-desk-monitor__controls">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"
            className="home-desk-monitor__file-input"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void upload(file)
              event.target.value = ""
            }}
          />
          {mediaUrl && (
            <>
              <button
                type="button"
                onClick={() => setFitMode(settings.fitMode === "cover" ? "contain" : "cover")}
                aria-label="Toggle fit mode"
              >
                {settings.fitMode === "cover" ? "Cover" : "Contain"}
              </button>
              {settings.mediaKind === "video" && (
                <button type="button" onClick={() => setMuted(!settings.muted)} aria-label="Toggle mute">
                  {settings.muted ? "Muted" : "Unmuted"}
                </button>
              )}
              <button type="button" onClick={() => void remove()} aria-label="Remove local media">
                Remove
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
