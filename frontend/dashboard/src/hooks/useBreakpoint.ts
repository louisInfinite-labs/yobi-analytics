import { useEffect, useState } from "react"
import type { Breakpoint } from "../types/widget"

const TABLET_MIN_WIDTH = 768
const DESKTOP_MIN_WIDTH = 1024

function resolveBreakpoint(width: number): Breakpoint {
  if (width < TABLET_MIN_WIDTH) return "mobile"
  if (width < DESKTOP_MIN_WIDTH) return "tablet"
  return "desktop"
}

/** Reactive viewport breakpoint, so layout persistence (useEditableLayout's
 * own profileId:breakpoint storage key) reads/writes the profile that
 * actually matches the current device instead of a hardcoded "desktop" —
 * without this, a mobile visit would read and overwrite the desktop
 * profile's saved layout. */
export function useBreakpoint(): Breakpoint {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>(() =>
    typeof window === "undefined" ? "desktop" : resolveBreakpoint(window.innerWidth),
  )

  useEffect(() => {
    function handleResize() {
      setBreakpoint(resolveBreakpoint(window.innerWidth))
    }
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [])

  return breakpoint
}
