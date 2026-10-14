import { useMemo } from "react"
import { isManualHomeScreenInstallPlatform, useInstallAvailability } from "../pwa/installState"

/** The 5 states Device Sync's UX actually branches on (the spec's own "Platform Summary"). `installed` ("-pwa") vs
 * not ("-browser"/"-safari") comes from the existing PWA install-state module's own standalone-display check
 * (installState.ts's isStandaloneDisplay, via useInstallAvailability) -- Device Sync adds no second, competing
 * notion of "is this installed". */
export type DeviceSyncPlatform = "pc" | "android-browser" | "android-pwa" | "ios-safari" | "ios-pwa"

/** Touch-primary form factor, used only to separate "PC browser" from "Android-family browser" when NEITHER is
 * installed (installState's own availability signal can't tell those apart: both are Chrome/Blink-family and
 * both get "prompt"). A deliberate, narrow, capability-based heuristic (pointer/hover media features, not a UA
 * string) -- not perfect (a touchscreen Windows laptop would read as touch-primary), but this is the standard way
 * to feature-detect "touch is the primary input" and the spec itself allows "some platform-specific instruction
 * wording may require targeted detection". iOS/iPadOS is never routed through this check at all: it's identified
 * first, and exclusively, by isManualHomeScreenInstallPlatform() below (a true WebKit-only capability, `navigator.
 * standalone` existing as a boolean -- desktop Safari never defines it), so this heuristic only ever has to tell
 * PC apart from Android/other touch-primary Chrome-family browsers. */
function isTouchPrimaryFormFactor(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia("(pointer: coarse)").matches
}

/** Pure resolver, independent of React -- `installed` is installState's own standalone-display check (passed in
 * so callers/tests can control it without faking matchMedia's display-mode query too). */
export function resolveDeviceSyncPlatform(installed: boolean): DeviceSyncPlatform {
  if (isManualHomeScreenInstallPlatform()) return installed ? "ios-pwa" : "ios-safari"
  if (isTouchPrimaryFormFactor()) return installed ? "android-pwa" : "android-browser"
  // Desktop is never routed to the mobile/guidance states regardless of install state: a desktop browser that
  // installs OshiYobi as a desktop app (Chrome/Edge's own "Install as app") is still a desktop form factor with a
  // mouse, not a camera-first mobile device -- the PC page's own QR/code/enter-code UI is still the right one.
  return "pc"
}

/** React hook form: reactive to installState's own install/appinstalled/display-mode listeners via
 * useInstallAvailability, so a live install (desktop Chrome's install button, or iOS Add to Home Screen taking
 * effect on next launch) updates this without a page reload. */
export function useDeviceSyncPlatform(): DeviceSyncPlatform {
  const { availability } = useInstallAvailability()
  const installed = availability === "installed"
  return useMemo(() => resolveDeviceSyncPlatform(installed), [installed])
}
