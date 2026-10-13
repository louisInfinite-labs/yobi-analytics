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

export type InstallAvailability = "installed" | "prompt" | "manual" | "unavailable"

/** What the install row in Settings can offer right now: nothing when already installed; the browser's own install prompt where the
 * platform provides one (Android/desktop Chrome, Edge); Add-to-Home-Screen guidance on iOS/iPadOS Safari; otherwise nothing. */
export function readInstallAvailability(): InstallAvailability {
  if (installed || isStandaloneDisplay()) return "installed"
  if (deferredPrompt) return "prompt"
  if (isManualHomeScreenInstallPlatform()) return "manual"
  return "unavailable"
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
