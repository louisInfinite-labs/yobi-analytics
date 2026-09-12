import { useCallback, useEffect, useState } from "react"
import {
  clampScale,
  DEFAULT_OSHI_TRANSFORM,
  readOshiTransform,
  resetOshiTransform,
  writeOshiTransform,
  type OshiTransform,
} from "../lib/oshiTransformStore"

/** Loads/persists one creator's Oshi position+scale, and exposes drag/scale/reset
 * actions (Spec's "V1 may expose only basic drag, scale, and reset controls"). */
export function useOshiTransform(creatorId: string) {
  const [transform, setTransform] = useState<OshiTransform>(() => readOshiTransform(creatorId))

  useEffect(() => {
    setTransform(readOshiTransform(creatorId))
  }, [creatorId])

  const moveTo = useCallback(
    (x: number, y: number) => {
      setTransform((prev) => {
        const next = { ...prev, x, y }
        writeOshiTransform(creatorId, next)
        return next
      })
    },
    [creatorId],
  )

  const setScale = useCallback(
    (scale: number) => {
      setTransform((prev) => {
        const next = { ...prev, scale: clampScale(scale) }
        writeOshiTransform(creatorId, next)
        return next
      })
    },
    [creatorId],
  )

  const reset = useCallback(() => {
    resetOshiTransform(creatorId)
    setTransform(DEFAULT_OSHI_TRANSFORM)
  }, [creatorId])

  return { transform, moveTo, setScale, reset }
}
