import { useCallback, useEffect, useState } from "react"

/** Chrome/Edge/Android's install event. Not in lib.dom, so typed here. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

let deferredPrompt: BeforeInstallPromptEvent | null = null
let installed = false
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((listener) => listener())
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    // Hold the event instead of letting the browser show its own mini-infobar: installing stays an explicit choice in Settings.
    event.preventDefault()
    deferredPrompt = event as BeforeInstallPromptEvent
    notify()
  })
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null
    installed = true
    notify()
  })
}

/** True when the page is running as an installed app (Home Screen / standalone window) rather than in a browser tab. */
export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false
  if (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) return true
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

/** iOS/iPadOS Safari exposes `navigator.standalone` (a boolean) and has no install event: installing is Share -> Add to Home Screen.
 * Detected by that capability, not by a user-agent string -- it also covers iPadOS reporting a desktop UA. */
export function isManualHomeScreenInstallPlatform(): boolean {
  return typeof navigator !== "undefined" && typeof (navigator as Navigator & { standalone?: boolean }).standalone === "boolean"
}

/** Whether the visitor is on a phone browser (any browser on iPhone or an Android phone). Decided from the device, never from the viewport width: a desktop
 * browser resized to a narrow window is not a phone. Uses the User-Agent Client Hints `mobile` flag where the browser provides it and falls back to the
 * User-Agent string elsewhere (Safari and Firefox expose no client hints). iPadOS and Android tablets are not phones. */
export function isMobilePhoneBrowser(): boolean {
  if (typeof navigator === "undefined") return false
  const hinted = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile
  if (typeof hinted === "boolean") return hinted
  const agent = navigator.userAgent ?? ""
  return /iPhone|iPod/.test(agent) || (/Android/.test(agent) && /Mobile/.test(agent)) || /Windows Phone|IEMobile|Opera Mini|BlackBerry/.test(agent)
}

/** "installed": running as an installed app (standalone display) or installed during this visit -- the section is hidden entirely.
 * "notMobile": not a phone browser (desktop, tablet, or a narrow desktop window) -- hidden entirely.
 * "prompt": the browser holds an install prompt (Chrome/Android). "manual": iOS Add to Home Screen steps. "browserMenu": a phone browser with no install
 * prompt and no iOS capability (for example Android before the browser offers the prompt): generic browser-menu steps. */
export type InstallAvailability = "installed" | "notMobile" | "prompt" | "manual" | "browserMenu"

/** What the install section can offer right now. Only a phone browser outside the installed app sees it at all; an installed copy elsewhere does not
 * hide it. Where the platform has an install prompt the section triggers it (only after a tap); on iOS it explains Add to Home Screen, since iOS has
 * no programmatic install; otherwise it explains the browser menu. */
export function readInstallAvailability(): InstallAvailability {
  if (installed || isStandaloneDisplay()) return "installed"
  if (!isMobilePhoneBrowser()) return "notMobile"
  if (deferredPrompt) return "prompt"
  if (isManualHomeScreenInstallPlatform()) return "manual"
  return "browserMenu"
}

export function useInstallAvailability(): { availability: InstallAvailability; promptInstall: () => Promise<void> } {
  const [availability, setAvailability] = useState<InstallAvailability>(readInstallAvailability)

  useEffect(() => {
    const update = () => setAvailability(readInstallAvailability())
    listeners.add(update)
    update()
    return () => {
      listeners.delete(update)
    }
  }, [])

  const promptInstall = useCallback(async () => {
    const event = deferredPrompt
    if (!event) return
    // The saved event is single-use whatever the choice.
    deferredPrompt = null
    notify()
    await event.prompt()
    await event.userChoice
  }, [])

  return { availability, promptInstall }
}

/** Test seam: forget the held install event and the installed flag. */
export function resetInstallStateForTests(): void {
  deferredPrompt = null
  installed = false
  listeners.clear()
}
