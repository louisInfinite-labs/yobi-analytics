import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { oshiImagePathFor } from "../../lib/homeAssets"
import { useOshiTransform } from "../../hooks/useOshiTransform"

interface OshiLayerProps {
  creatorId: string
  /** The scene container this layer's percentage coordinates are relative to — drag math needs its live pixel size. */
  sceneRef: React.RefObject<HTMLDivElement | null>
  editable: boolean
}

/** Layer 2: the selected creator's transparent Oshi image, positioned/scaled
 * independently from the room (spec: "Render the selected creator's
 * transparent image independently from the room"). Drag/scale/reset are the
 * only V1 controls (no full scene editor). */
export function OshiLayer({ creatorId, sceneRef, editable }: OshiLayerProps) {
  const { transform, moveTo, setScale, reset } = useOshiTransform(creatorId)
  const [imageFailed, setImageFailed] = useState(false)
  const dragState = useRef<{ pointerId: number; offsetXPercent: number; offsetYPercent: number } | null>(null)

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!editable || !sceneRef.current) return
      const sceneRect = sceneRef.current.getBoundingClientRect()
      const pointerXPercent = ((event.clientX - sceneRect.left) / sceneRect.width) * 100
      const pointerYPercent = ((event.clientY - sceneRect.top) / sceneRect.height) * 100
      dragState.current = {
        pointerId: event.pointerId,
        offsetXPercent: pointerXPercent - transform.x,
        offsetYPercent: pointerYPercent - transform.y,
      }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [editable, sceneRef, transform.x, transform.y],
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragState.current
      if (!drag || drag.pointerId !== event.pointerId || !sceneRef.current) return
      const sceneRect = sceneRef.current.getBoundingClientRect()
      const pointerXPercent = ((event.clientX - sceneRect.left) / sceneRect.width) * 100
      const pointerYPercent = ((event.clientY - sceneRect.top) / sceneRect.height) * 100
      moveTo(
        Math.min(100, Math.max(0, pointerXPercent - drag.offsetXPercent)),
        Math.min(100, Math.max(0, pointerYPercent - drag.offsetYPercent)),
      )
    },
    [moveTo, sceneRef],
  )

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragState.current?.pointerId === event.pointerId) dragState.current = null
  }, [])

  return (
    <div
      className={`home-scene__layer home-oshi${editable ? " home-oshi--editable" : ""}`}
      style={{ left: `${transform.x}%`, top: `${transform.y}%`, transform: `translate(-50%, -100%) scale(${transform.scale})` }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      role={editable ? "slider" : undefined}
      aria-label={editable ? "Oshi image position" : undefined}
      aria-valuenow={editable ? Math.round(transform.scale * 100) : undefined}
    >
      {imageFailed ? (
        <div className="home-placeholder home-placeholder--oshi">Oshi image</div>
      ) : (
        <img
          className="home-oshi__image"
          src={oshiImagePathFor(creatorId)}
          alt=""
          draggable={false}
          onError={() => setImageFailed(true)}
        />
      )}
      {editable && (
        <div className="home-oshi__controls" onPointerDown={(event) => event.stopPropagation()}>
          <input
            type="range"
            min={40}
            max={250}
            value={Math.round(transform.scale * 100)}
            onChange={(event) => setScale(Number(event.target.value) / 100)}
            aria-label="Oshi scale"
          />
          <button type="button" onClick={reset}>
            Reset
          </button>
        </div>
      )}
    </div>
  )
}
