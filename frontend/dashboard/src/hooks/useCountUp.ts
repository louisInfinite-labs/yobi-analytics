import { useEffect, useRef, useState } from "react"

/** Animates a number from 0 to target over durationMs (ease-out), or returns
 * target immediately when disabled (prefers-reduced-motion). */
export function useCountUp(target: number, durationMs: number, disabled: boolean): number {
  const [value, setValue] = useState(disabled ? target : 0)
  const frameRef = useRef<number>(0)

  useEffect(() => {
    if (disabled) {
      setValue(target)
      return
    }

    const start = performance.now()
    const from = 0

    function tick(now: number) {
      const elapsed = now - start
      const progress = Math.min(elapsed / durationMs, 1)
      const eased = 1 - (1 - progress) ** 3 // ease-out cubic
      setValue(from + (target - from) * eased)
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick)
      }
    }

    frameRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs, disabled])

  return value
}
