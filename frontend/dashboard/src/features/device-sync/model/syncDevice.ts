import type { DeviceSyncPlatform } from "../platformDetection"

/** Mirrors the backend's sync_profile_api.DeviceType exactly -- api_handler.py's /sync/* routes reject anything else. */
export type DeviceType = "desktop" | "android" | "ios"

export function deviceTypeForPlatform(platform: DeviceSyncPlatform): DeviceType {
  if (platform === "ios-safari" || platform === "ios-pwa") return "ios"
  if (platform === "android-browser" || platform === "android-pwa") return "android"
  return "desktop"
}

/** Best-effort browser name, for the device label ONLY -- never for a capability/security decision (platformDetection.ts
 * owns those, via feature detection). Worst case here is a cosmetic "Browser" fallback, not a functional break. */
function guessBrowserName(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : ""
  if (/Edg\//.test(ua)) return "Edge"
  if (/Firefox\//.test(ua)) return "Firefox"
  if (/CriOS|Chrome\//.test(ua)) return "Chrome"
  if (/Safari\//.test(ua)) return "Safari"
  return "Browser"
}

/** The default device label offered when creating/joining a pairing session -- shown to the user as a suggestion,
 * editable nowhere in V1 (kept simple), but never a raw deviceId (spec section 21: never expose that as the UI label). */
export function defaultDeviceLabel(platform: DeviceSyncPlatform): string {
  switch (platform) {
    case "pc":
      return `Desktop ${guessBrowserName()}`
    case "android-pwa":
      return "Android PWA"
    case "android-browser":
      return `Android ${guessBrowserName()}`
    case "ios-pwa":
      return /iPad/.test(typeof navigator !== "undefined" ? navigator.userAgent : "") ? "iPad PWA" : "iPhone PWA"
    case "ios-safari":
      return /iPad/.test(typeof navigator !== "undefined" ? navigator.userAgent : "") ? "iPad Safari" : "iPhone Safari"
  }
}
